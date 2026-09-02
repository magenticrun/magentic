# Plan 006: A shell command cannot exhaust the gateway's memory or hang the call past its timeout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- packages/tools/src/ShellTool.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition. (Plan 005 edits `resolveWorkdir` in the same file; that
> change is expected if 005 landed first and does not affect this plan.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (003 makes the tool reachable; this plan is worth landing before or with it)
- **Category**: bug
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

The shell tool collects a child's whole stdout and stderr into memory with `Stream.mkString`, and only afterwards trims each to `OUTPUT_LIMIT` (30,000 characters) with `cut`. The model is told output "is cut in the middle past 30000 characters", so it has no reason to avoid verbose commands, and the default 120-second window is long enough to emit gigabytes. One chatty command can take down the gateway process and every run in it. Separately, when the timeout fires the child is killed, but the handler then `Fiber.join`s the two collectors with no limit; those streams end only when every writer closes the pipe, and `sh -c` routinely leaves grandchildren (dev servers, backgrounded processes) holding it, so a timed-out call can hang forever even though the tool promises it "comes back with timedOut set". This plan bounds memory while streaming and puts a grace period on the collectors, keeping the exact output shape the model already knows.

## Current state

- `packages/tools/src/ShellTool.ts:16-20`:

  ```ts
  /** Characters of stdout or stderr the model gets back; the middle goes when there is more. */
  export const OUTPUT_LIMIT = 30_000;
  /** How long a timed-out command gets to exit on SIGTERM before SIGKILL. */
  const FORCE_KILL_AFTER = "2 seconds";
  ```

- `packages/tools/src/ShellTool.ts:75-91` — `Captured` and `cut`:

  ```ts
  interface Captured {
    readonly text: string;
    readonly truncated: boolean;
  }

  /** The first and last halves of an over-long output, with a note where the middle was. */
  const cut = (text: string): Captured => {
    if (text.length <= OUTPUT_LIMIT) {
      return { text, truncated: false };
    }
    const half = Math.floor(OUTPUT_LIMIT / 2);
    const omitted = text.length - 2 * half;
    return {
      text: `${text.slice(0, half)}\n… ${omitted} characters omitted …\n${text.slice(-half)}`,
      truncated: true,
    };
  };
  ```

- `packages/tools/src/ShellTool.ts:139-160` — the collection and the join:

  ```ts
  // Drain both pipes while the command runs, or a chatty one blocks on a full pipe.
  const collect = (stream: Stream.Stream<Uint8Array, { readonly message: string }>) =>
    stream.pipe(Stream.decodeText(), Stream.mkString, Effect.mapError(spawnFailed));
  const stdout = yield * Effect.forkChild(collect(handle.stdout));
  const stderr = yield * Effect.forkChild(collect(handle.stderr));
  const exit =
    yield * handle.exitCode.pipe(Effect.mapError(spawnFailed), Effect.timeoutOption(limit));
  if (Option.isNone(exit)) {
    yield * handle.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
  }
  const out = cut(yield * Fiber.join(stdout));
  const err = cut(yield * Fiber.join(stderr));
  const finished = yield * Clock.currentTimeMillis;
  return {
    exitCode: Option.isSome(exit) ? Number(exit.value) : null,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    timedOut: Option.isNone(exit),
    durationMs: finished - started,
  };
  ```

- Imports at the top of the file: `import { Clock, Effect, Fiber, Option, Path, Schema, Stream } from "effect";`.
- Effect 4 APIs available (checked in `node_modules/effect/dist`): `Stream.runForEach` (`Stream.d.ts:14503`), `Ref.make/get/update`, `Fiber.join` and `Fiber.interrupt` (`Fiber.d.ts:258, 323`), `Effect.timeoutOption`.
- There is no `ShellTool.test.ts`. CLAUDE.md makes new test files opt-in, so this plan verifies with a throwaway script instead (Step 4) unless the operator has approved a test file.

## Commands you will need

| Purpose    | Command                               | Expected on success |
| ---------- | ------------------------------------- | ------------------- |
| Typecheck  | `bun run typecheck`                   | exit 0              |
| Lint       | `bun run lint`                        | exit 0              |
| Tool tests | `bun --bun vitest run packages/tools` | all pass            |
| All        | `bun run check`                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/tools/src/ShellTool.ts`

**Out of scope** (do NOT touch, even though they look related):

- `packages/tools/src/FileTools.ts` — its own size caps are finding BUG-02, a separate plan.
- `resolveWorkdir` in `ShellTool.ts` — plan 005 owns it.
- Killing the child's whole process group — Effect's `ChildProcess.kill` has no group option in this rc; the grace timeout is the mitigation. Record the group kill as deferred, do not implement it here.
- The tool's `description` string: the model-facing contract ("cut in the middle past 30000 characters", "comes back with timedOut set") stays exactly as it is, and the implementation now honours it.

## Git workflow

- Branch: `fix/shell-output-bounds`
- Commit style: conventional commits, e.g. `fix: bound shell output while it streams and stop waiting on orphaned pipes`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: A bounded buffer that keeps head and tail

Replace `Captured` and `cut` with a buffer that never holds more than `OUTPUT_LIMIT` characters plus one chunk:

```ts
/** How long the collectors may keep reading after the command ended before we take what they have. */
const COLLECT_GRACE = "2 seconds";

interface Captured {
  readonly text: string;
  readonly truncated: boolean;
}

/** Output kept while it streams: the first half, the last half, and how much fell between. */
interface Bounded {
  readonly head: string;
  readonly tail: string;
  readonly omitted: number;
}

const HALF = Math.floor(OUTPUT_LIMIT / 2);
const EMPTY: Bounded = { head: "", tail: "", omitted: 0 };

/** Appends a chunk, keeping at most `HALF` characters at each end. */
const push = (buffer: Bounded, chunk: string): Bounded => {
  if (
    buffer.omitted === 0 &&
    buffer.tail === "" &&
    buffer.head.length + chunk.length <= OUTPUT_LIMIT
  ) {
    return { ...buffer, head: buffer.head + chunk };
  }
  // Past the limit: split what we have into a fixed head and a sliding tail.
  const joined =
    buffer.tail === "" && buffer.omitted === 0 ? buffer.head + chunk : buffer.tail + chunk;
  const head = buffer.tail === "" && buffer.omitted === 0 ? joined.slice(0, HALF) : buffer.head;
  const rest = buffer.tail === "" && buffer.omitted === 0 ? joined.slice(HALF) : joined;
  const tail = rest.slice(-HALF);
  const omitted = buffer.omitted + (rest.length - tail.length);
  return { head, tail, omitted };
};

/** The text the model sees, with a note where the middle was. */
const render = (buffer: Bounded): Captured =>
  buffer.omitted === 0 && buffer.tail === ""
    ? { text: buffer.head, truncated: false }
    : {
        text: `${buffer.head}\n… ${buffer.omitted} characters omitted …\n${buffer.tail}`,
        truncated: true,
      };
```

Property to preserve: for an output of length `n > OUTPUT_LIMIT` fed in any chunking, `render` gives the first `HALF` characters, then the note, then the last `HALF` characters, with `omitted = n - 2 * HALF`; for `n <= OUTPUT_LIMIT` it gives the text unchanged. Step 4 checks this.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Collect into a `Ref` so an interrupted collector still yields what it had

Replace `collect` and the two forks:

```ts
// Drain both pipes while the command runs, or a chatty one blocks on a full pipe.
// Each chunk lands in a Ref, so what was read survives interrupting the reader.
const collect = (stream: Stream.Stream<Uint8Array, { readonly message: string }>) =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make(EMPTY);
    const reader = yield* Effect.forkChild(
      stream.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(buffer, (b) => push(b, chunk))),
        Effect.mapError(spawnFailed),
      ),
    );
    return { buffer, reader };
  });
const stdout = yield * collect(handle.stdout);
const stderr = yield * collect(handle.stderr);
```

Add `Ref` to the `effect` import.

**Verify**: `bun run typecheck` → exit 0

### Step 3: Join with a grace period, then read the buffers

Replace the `cut(yield* Fiber.join(...))` lines with:

```ts
/** Wait for a reader to finish; past the grace period take what it has and stop it. */
const settle = (collector: {
  buffer: Ref.Ref<Bounded>;
  reader: Fiber.Fiber<void, ShellToolError>;
}) =>
  Effect.gen(function* () {
    const done = yield* Fiber.join(collector.reader).pipe(
      Effect.ignore,
      Effect.timeoutOption(COLLECT_GRACE),
    );
    if (Option.isNone(done)) {
      yield* Fiber.interrupt(collector.reader);
    }
    return render(yield* Ref.get(collector.buffer));
  });
const out = yield * settle(stdout);
const err = yield * settle(stderr);
```

Check the exact `Fiber.Fiber` type parameters the forked reader has (hover or read the error message) and adjust the `settle` parameter type; if the type is awkward, infer it with `typeof stdout` instead of spelling it out. Note the grace applies after the command exited or was killed; a command that runs to completion within its timeout is unaffected because its pipes close when it exits.

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0; `bun --bun vitest run packages/tools` → all pass

### Step 4: Prove the two properties with a throwaway script

Create `apps/gateway/src/tmp-shell-check.ts` (that directory resolves every workspace dependency; the repo root does not) with:

```ts
import { BunServices } from "@effect/platform-bun";
import { ShellToolsLayer, ShellTools, WorkspaceRoot } from "@magentic/tools";
import { Effect, Layer, Stream } from "effect";

const Live = ShellToolsLayer.pipe(
  Layer.provideMerge(WorkspaceRoot.layer(process.cwd())),
  Layer.provideMerge(BunServices.layer),
);

const call = (command: string, timeout?: number) =>
  Effect.gen(function* () {
    const kit = yield* ShellTools;
    const stream = yield* kit.handle("shell", { command, timeout }, "c");
    const [result] = yield* Stream.runCollect(stream);
    return result!.encodedResult as {
      stdout: string;
      truncated: boolean;
      timedOut: boolean;
      durationMs: number;
    };
  });

const program = Effect.gen(function* () {
  const big = yield* call("head -c 200000000 /dev/zero | tr '\\0' 'a'");
  console.log(
    "big: truncated",
    big.truncated,
    "stdout length",
    big.stdout.length,
    "starts",
    big.stdout.slice(0, 5),
    "note",
    big.stdout.includes("characters omitted"),
  );
  const rss = process.memoryUsage().rss / 1e6;
  console.log("rss MB", Math.round(rss));
  const hang = yield* call("(sleep 60 &) ; echo started", 1000);
  console.log(
    "hang: timedOut",
    hang.timedOut,
    "durationMs",
    hang.durationMs,
    "stdout",
    JSON.stringify(hang.stdout),
  );
});

Effect.runPromise(program.pipe(Effect.provide(Live), Effect.scoped)).then(() => process.exit(0));
```

Run `bun run apps/gateway/src/tmp-shell-check.ts`. Expected:

- `big: truncated true stdout length <about 30040> starts aaaaa note true` — 200 MB of output, but the returned text is about `OUTPUT_LIMIT` characters plus the note.
- `rss MB` well under 500 (before this plan, the same command holds 200 MB of string in memory and the number is over 400).
- `hang: timedOut true durationMs <between 1000 and about 5000>` — the call returns even though a grandchild still holds the pipe; before this plan it hangs for 60 seconds.

Then delete the script: `rm apps/gateway/src/tmp-shell-check.ts`.

**Verify**: the three printed lines as described, and `ls apps/gateway/src/tmp-shell-check.ts` → "No such file".

### Step 5: Full check

**Verify**: `bun run check` → exit 0

## Test plan

- No new test file (opt-in rule). If the operator approves `packages/tools/src/ShellTool.test.ts`, port Step 4 into it: model the layer on `packages/tools/src/FileTools.test.ts:19-30` (temp workspace via `makeTempDirectoryScoped`), assert `truncated`, the head/tail shape of `stdout`, and `timedOut` with a bounded `durationMs`. Add a pure test for `push`/`render`: feed `"x".repeat(70_000)` in chunks of 1, 7, and 70,000 and assert identical output, `omitted === 70_000 - 2 * HALF`.
- Existing `packages/tools` tests keep passing.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "Stream.mkString" packages/tools/src/ShellTool.ts` → no matches
- [ ] `grep -n "COLLECT_GRACE" packages/tools/src/ShellTool.ts` → at least 2 matches
- [ ] Step 4 output observed and recorded in the report (truncated big output, bounded RSS, timed-out call returns)
- [ ] `apps/gateway/src/tmp-shell-check.ts` does not exist
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only `packages/tools/src/ShellTool.ts` (plus the pre-existing uncommitted `packages/mcp` work)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Step 4 `hang` case still takes about 60 seconds after Step 3 — the readers are not being interrupted; report rather than adding `process.kill` calls.
- `Stream.runForEach` or `Effect.timeoutOption` are not available under those names in the installed rc.
- The lint plugin rejects the `as` in the throwaway script — it is deleted before `bun run check`, so run the script before linting; if you must keep it around, add a `// SAFETY:` comment.
- Any existing `packages/tools` test fails after Step 3.

## Maintenance notes

- `push`/`render` reproduce `cut`'s exact output; if `OUTPUT_LIMIT` changes, both halves follow it.
- Reviewers: check that `settle` is applied to both stdout and stderr, and that the grace is only paid when a reader outlives the child.
- Deferred: killing the process group so grandchildren die with the command (needs a spawner option Effect does not expose yet); a `Bun.spawn`-based spawner could add it later.
