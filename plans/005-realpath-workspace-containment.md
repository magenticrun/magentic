# Plan 005: File tools and the shell workdir stay inside the workspace even through symlinks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- packages/tools/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (a workspace that intentionally symlinks outside itself starts being refused; links that resolve back inside stay allowed)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

`WorkspaceRoot` is documented as "Absolute directory that file tools may touch. Nothing outside it is reachable." The check that enforces it, `resolveInside` in `packages/tools/src/FileTools.ts`, is purely lexical: `path.resolve` plus `path.relative` plus a `..` test. It never resolves symlinks, and no `realPath` call exists anywhere in the repo. A checked-out repository that contains a symlink to `$HOME`, `/etc`, or `~/.config/magentic` (where provider API keys live) lets `read_file` read through it, `write_file` and `edit_file` write through it, and `grep` walk and read it. The shell tool has the same lexical check for `workdir` (`resolveWorkdir`). The file tools are deliberately a separate plugin so a team can run them without shell; when they are the only tools, this check is the whole boundary. The existing containment test only covers `..`, absolute paths, and `a/../../b`, so the gap is invisible to `bun run check`.

## Current state

- `packages/tools/src/WorkspaceRoot.ts` — the whole file:

  ```ts
  import { Context, Layer } from "effect";

  /** Absolute directory that file tools may touch. Nothing outside it is reachable. */
  export class WorkspaceRoot extends Context.Service<WorkspaceRoot, string>()(
    "magentic/tools/WorkspaceRoot",
  ) {
    static readonly layer = (root: string) => Layer.succeed(WorkspaceRoot, root);
  }
  ```

- `packages/tools/src/FileTools.ts:200-212` — the lexical check:

  ```ts
  /** Resolve a user path against the root and refuse anything that escapes it. */
  const resolveInside = Effect.fn("FileTools.resolveInside")(function* (requested: string) {
    const absolute = path.resolve(root, requested);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new FileToolError({
        reason: "OutsideWorkspace",
        path: requested,
        message: `${requested} is outside the workspace`,
      });
    }
    return { absolute, relative };
  });
  ```

  `resolveDirectory` (`:225-241`) calls `resolveInside` then `fs.stat`. `read_file` (`:318-326`), `write_file` (`:328-334`), `edit_file` (`:342-384`), `list_dir` (`:388-409`) all go through one of them. `glob` (`:412-431`) and `grep` (`:434-476`) resolve their start directory with `resolveDirectory`, then call `walk`.

- `packages/tools/src/FileTools.ts:275-315` — `walk`: pops directories off a stack, `statAll`s each entry (`fs.stat` follows symlinks, so a link to a directory reports `type: "Directory"` and is descended; a link to a file reports `"File"` and is listed as `path.relative(root, full)`). `grep` then reads each listed file with `fs.readFileString(path.join(root, file))` (`:457`).
- `packages/tools/src/ShellTool.ts:104-116` — the same lexical check for the shell's `workdir`, producing `ShellToolError({ reason: "OutsideWorkspace", … })`.
- Effect's `FileSystem` (`node_modules/effect/dist/FileSystem.d.ts`) has `realPath(path): Effect<string, PlatformError>` (line 204) and `symlink(fromPath, toPath)` (line 255). `realPath` fails for a path that does not exist yet, which `write_file` to a new file needs to handle.
- `packages/tools/src/FileTools.test.ts:1-30` builds a temp workspace per file with `fs.makeTempDirectoryScoped({ prefix: "magentic-tools-" })` and `WorkspaceRoot.layer(dir)`. The containment test (`:117-131`) is:

  ```ts
    it.effect("refuses paths that escape the workspace", () =>
      Effect.gen(function* () {
        const toolkit = yield* FileTools;
        for (const path of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
          const result = yield* toolkit
            .handle("write_file", { path, content: "x" })
            .pipe(Effect.flatMap(lastResult));
          assert.isTrue(result.isFailure, path);
          assert.strictEqual(expectFileToolError(result.result).reason, "OutsideWorkspace", path);
        }
        ...
  ```

  `lastResult` and `expectFileToolError` are helpers defined earlier in that file; reuse them.

- Conventions: errors are `Schema.TaggedError` with a `reason` literal; traced functions use `Effect.fn("Service.method")`; no `throw`, no `as` without a `SAFETY:` comment.

## Commands you will need

| Purpose    | Command                               | Expected on success |
| ---------- | ------------------------------------- | ------------------- |
| Typecheck  | `bun run typecheck`                   | exit 0              |
| Lint       | `bun run lint`                        | exit 0              |
| Tool tests | `bun --bun vitest run packages/tools` | all pass            |
| All        | `bun run check`                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/tools/src/WorkspaceRoot.ts` (add the shared resolver)
- `packages/tools/src/FileTools.ts` (use it; guard `walk` and `grep`)
- `packages/tools/src/ShellTool.ts` (use it for `workdir`)
- `packages/tools/src/FileTools.test.ts` (symlink cases)

**Out of scope** (do NOT touch, even though they look related):

- `packages/core/**`, `apps/**` — nothing there resolves workspace paths.
- Performance of `walk` and `grep` beyond what this plan needs (findings PERF-01/PERF-02 are separate).
- A new `ShellTool.test.ts` — new test files need the operator's approval (CLAUDE.md); the shell path is covered by the shared resolver's tests through `FileTools.test.ts`.

## Git workflow

- Branch: `fix/realpath-containment`
- Commit style: conventional commits, e.g. `fix: keep file tools and shell workdir inside the real workspace`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One resolver in `WorkspaceRoot.ts`

Add to `packages/tools/src/WorkspaceRoot.ts` (import `Effect`, `FileSystem`, `Option`, `Path` from `effect`):

```ts
export interface Resolved {
  /** The lexical absolute path the caller may open. */
  readonly absolute: string;
  /** Workspace-relative, `""` for the root itself. */
  readonly relative: string;
}

/**
 * Where `requested` lands under `root`, or none when it escapes. Lexical
 * first, then the real path of the deepest ancestor that exists, so a link
 * inside the workspace that points outside it is refused and a link that
 * points back inside is allowed. A target that does not exist yet is
 * judged by its nearest existing parent.
 */
export const resolveWithin = Effect.fn("WorkspaceRoot.resolveWithin")(function* (
  root: string,
  requested: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return Option.none<Resolved>();
  }
  const realRoot = yield* fs.realPath(root);
  // Walk up until something exists; realPath refuses a path that is not there yet.
  let probe = absolute;
  let real = Option.none<string>();
  while (Option.isNone(real)) {
    real = yield* fs.realPath(probe).pipe(Effect.option);
    if (Option.isSome(real)) {
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      return Option.none<Resolved>();
    }
    probe = parent;
  }
  const rest = path.relative(probe, absolute);
  const realTarget = rest === "" ? real.value : path.join(real.value, rest);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    return Option.none<Resolved>();
  }
  const resolved: Resolved = { absolute, relative };
  return resolved;
});
```

The function's error channel is `PlatformError` from `realPath(root)` only; callers map it to their own error.

**Verify**: `bun run typecheck` → exit 0

### Step 2: File tools use it

In `packages/tools/src/FileTools.ts`, import `resolveWithin` from `./WorkspaceRoot.ts` and replace the body of `resolveInside` with:

```ts
const resolveInside = Effect.fn("FileTools.resolveInside")(function* (requested: string) {
  const outside = () =>
    new FileToolError({
      reason: "OutsideWorkspace",
      path: requested,
      message: `${requested} is outside the workspace`,
    });
  const resolved = yield* resolveWithin(root, requested).pipe(
    Effect.mapError((error) => ioError(requested)(error)),
  );
  if (Option.isNone(resolved)) {
    return yield* outside();
  }
  return resolved.value;
});
```

`ioError` is defined a few lines below `resolveInside` today; move its definition above `resolveInside` so it is in scope.

Then two more guards:

1. In `walk`, before `subdirectories.push(full)`, only push a directory whose real path is inside the real root. Compute `realRoot` once at the top of `fileToolHandlers` (`const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));`) and in `walk`:

   ```ts
   if (info.value.type === "Directory") {
     if (!pruned(name) && yield * insideReal(full)) {
       subdirectories.push(full);
     }
     continue;
   }
   ```

   with, beside `walk`:

   ```ts
   /** Whether an existing entry's real path is under the real root; a link elsewhere is not. */
   const insideReal = (full: string) =>
     Effect.map(fs.realPath(full).pipe(Effect.option), (real) => {
       if (Option.isNone(real)) {
         return false;
       }
       const relative = path.relative(realRoot, real.value);
       return !relative.startsWith("..") && !path.isAbsolute(relative);
     });
   ```

2. In `grep`, before reading each file, skip it unless `yield* insideReal(path.join(root, file))` is true. `glob` needs no change: it returns names only, and reading them later goes through `resolveInside`.

**Verify**: `bun run typecheck` → exit 0; `bun --bun vitest run packages/tools` → all existing tests pass

### Step 3: Shell workdir uses it

In `packages/tools/src/ShellTool.ts`, replace the body of `resolveWorkdir` so it calls `resolveWithin(root, requested ?? ".")`, maps a `PlatformError` to `ShellToolError({ reason: "SpawnFailed", message })`, and returns `resolved.value.absolute`; `Option.none` becomes the existing `OutsideWorkspace` error. Remove the now-unused `path` usage if nothing else in the file needs it (check before deleting the import).

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0

### Step 4: Symlink tests

In `packages/tools/src/FileTools.test.ts`, add a test in the same `layer(TestLayer)` block as the containment test. It needs a directory outside the workspace and a link inside it:

```ts
it.effect(
  "refuses a symlink that points outside the workspace, and follows one that stays inside",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* WorkspaceRoot;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-outside-" });
      yield* fs.writeFileString(`${outside}/secret.txt`, "no");
      yield* fs.symlink(`${outside}/secret.txt`, `${root}/leak.txt`);
      yield* fs.symlink(outside, `${root}/leakdir`);
      yield* fs.makeDirectory(`${root}/inner`, { recursive: true });
      yield* fs.writeFileString(`${root}/inner/ok.txt`, "fine");
      yield* fs.symlink(`${root}/inner`, `${root}/innerlink`);
      const toolkit = yield* FileTools;

      for (const path of ["leak.txt", "leakdir/secret.txt", "leakdir/new.txt"]) {
        const read = yield* toolkit.handle("read_file", { path }).pipe(Effect.flatMap(lastResult));
        assert.strictEqual(expectFileToolError(read.result).reason, "OutsideWorkspace", path);
        const write = yield* toolkit
          .handle("write_file", { path, content: "x" })
          .pipe(Effect.flatMap(lastResult));
        assert.strictEqual(expectFileToolError(write.result).reason, "OutsideWorkspace", path);
      }
      const listed = yield* toolkit
        .handle("list_dir", { path: "leakdir" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(listed.result).reason, "OutsideWorkspace");

      const found = yield* toolkit
        .handle("grep", { pattern: "no" })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(found.isFailure);
      // SAFETY: a non-failure grep result is the Grep success shape.
      const matches = (found.result as Tool.Success<typeof Grep>).matches;
      assert.isFalse(matches.some((m) => m.path.includes("leak")));

      const inside = yield* toolkit
        .handle("read_file", { path: "innerlink/ok.txt" })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(inside.isFailure);
    }),
);
```

Check the `Grep` success schema's field name for matches in `FileTools.ts` (search for `GrepMatch`) and the `Tool.Success` helper name in `node_modules/effect/dist/unstable/ai/Tool.d.ts`; adjust the two identifiers if they differ. Add `WorkspaceRoot` to the test's imports if it is not already imported (it is, at line 17).

**Verify**: `bun --bun vitest run packages/tools` → all pass, one more test

### Step 5: Full check

**Verify**: `bun run check` → exit 0

## Test plan

- New test (Step 4): link to an outside file and to an outside directory are refused for read, write, and list; `grep` does not surface content through the outside link; a link that resolves inside the workspace still works.
- Existing containment test keeps passing unchanged.
- Pattern: the existing `"refuses paths that escape the workspace"` test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "export const resolveWithin" packages/tools/src/WorkspaceRoot.ts` → 1 match
- [ ] `grep -c "resolveWithin" packages/tools/src/FileTools.ts packages/tools/src/ShellTool.ts` → at least 1 each
- [ ] `grep -n "insideReal" packages/tools/src/FileTools.ts` → at least 3 matches (definition, walk, grep)
- [ ] `bun --bun vitest run packages/tools` passes with the new test
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only in-scope files (plus the pre-existing uncommitted `packages/mcp` work)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `fs.realPath` or `fs.symlink` is missing or spelled differently in the installed `effect`; report what `FileSystem.d.ts` offers.
- The temp directory itself is under a symlinked path on this machine (macOS `/var` → `/private/var`) and the _existing_ tests start failing after Step 2 — that means `realRoot` is not being compared against; re-read Step 1, and if it still fails, report rather than special-casing macOS.
- The full `packages/tools` suite becomes noticeably slower (more than 2× the previous wall-clock) — the per-file `realPath` in `grep` is too costly here; report the timing.
- Making `resolveWorkdir` share the resolver requires changing `ShellToolError`'s `reason` literals.

## Maintenance notes

- `resolveWithin` is now the single containment rule; any new tool that touches the workspace must use it, and reviewers should reject a new `path.resolve`/`path.relative` check elsewhere.
- Links that resolve back inside the workspace are allowed on purpose (monorepo tooling relies on them). If a team wants to forbid all links, that is a new `WorkspaceRoot` option, not a change to this rule.
- Deferred: `walk` still `stat`s every entry and `grep` now adds a `realPath` per file; finding PERF-01 (concurrent reads) would pay for both.
