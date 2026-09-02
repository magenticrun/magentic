# Plan 003: The shipped assistant's `shell` tool actually exists, and an agent that lists an unregistered tool is warned about at boot

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- apps/gateway/src/Server.ts apps/gateway/src/Handlers.test.ts packages/core/src/plugin/PluginHost.ts packages/core/src/plugin/PluginHost.test.ts`
> `Server.ts` and `PluginHost.ts` are EXPECTED to differ from `0f690ca` in the
> working tree: uncommitted work adds an `mcpPlugin` line to `HostLayer` and an
> `options` parameter to `builtin`. The excerpts below show the working tree.
> Any other mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (turns on command execution for the default agent; do plan 002 first)
- **Depends on**: 002 (loopback bind) — land it first, since this enables shell for every caller
- **Category**: bug
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

Commit `5fe3eda` ("feat: shell tool and a fuller assistant prompt") added a shell tool plugin and rewrote the built-in assistant's prompt around it: the prompt says "Your tools are read_file, … and shell" and spends a section on how to use it, and the agent's `tools` list includes `"shell"`. But `shellToolPlugin` is only imported in `apps/gateway/src/Server.ts`; it is never added to `builtinPlugins`, so no plugin registers a tool called `shell`. `ToolRegistry.forAgent` silently intersects the agent's list with what is registered, so the assistant runs without `shell`, and if the model calls it anyway it gets `ToolCallRefused: shell is not available to assistant`, something the prompt never told it could happen. Nothing warned at boot. This plan wires the plugin and adds the boot-time warning so an agent naming a tool nobody registered is visible in the log, which also covers `agents/*.yaml` typos and MCP servers that failed to connect.

## Current state

- `apps/gateway/src/Server.ts:9-10` (working tree) — imports:

  ```ts
  import { fileToolsPlugin, shellToolPlugin, WorkspaceRoot } from "@magentic/tools";
  ```

- `apps/gateway/src/Server.ts:67-72` (working tree) — the list that decides what the gateway hosts:

  ```ts
  /** What we ship, in the order their contributions take. External plugins follow. */
  export const builtinPlugins = [
    builtin(fileToolsPlugin),
    ...modelPlugins.map(builtin),
    builtin(assistantPlugin),
  ];
  ```

- `apps/gateway/src/Server.ts:53` — the assistant's tool list:

  ```ts
  tools: ["read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "shell"],
  ```

- `packages/tools/src/ShellToolPlugin.ts` — the plugin, id `"shell"`, needs `ChildProcessSpawner`, `Path`, and `WorkspaceRoot`. `BunServices.layer` (already provided to the host in `Server.ts:114-118` and in tests) supplies the first two; `WorkspaceLayer` supplies the third, exactly as `fileToolsPlugin` already gets it.
- `packages/core/src/plugin/PluginHost.ts` — the boot batch. After the plugin loop:

  ```ts
  yield * Ref.set(booting, false);
  yield * rebuild;

  const runtimeRef: PluginRef = { id: "runtime", order: options.plugins.length };
  ```

  Registries available in that scope: `tools` (a `Registry<ToolEntry>`, `tools.values` gives `ReadonlyArray<ToolEntry>` with `entry.tool.name`), `agents` (a `Ref<ReadonlyMap<string, AgentDefinition>>`), and `options.disabledTools` (tool names hidden by `magentic.yaml`).

- `packages/plugin/src/Tools.ts` exports `toolMatches(pattern, name)`: exact match, or prefix match when the pattern ends in `*`. `ToolRegistry.forAgent` already uses it. Import it in `PluginHost.ts` from `@magentic/plugin` (the file already imports from there).
- Logging convention: `Effect.logWarning(\`plugin ${id} failed to set up: ${error}\`)` in the same file — plain template strings, lowercase, no trailing period.
- `apps/gateway/src/Handlers.test.ts` builds its own host with `builtin(fileToolsPlugin)`, a fake provider, and a `triage` agent; it does not use `builtinPlugins`. `Server.ts` exports `builtinPlugins` and `assistant`; importing them in the test is fine (module-level definitions only).
- `packages/core/src/plugin/PluginHost.test.ts:75-89` registers a `helper` agent whose tools are `["echo", "hidden"]`; `hidden` is in `disabledTools`. No agent there lists a tool that is simply unregistered.

## Commands you will need

| Purpose             | Command                                                                                                                    | Expected on success                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Typecheck           | `bun run typecheck`                                                                                                        | exit 0                                        |
| Lint                | `bun run lint`                                                                                                             | exit 0                                        |
| Host tests          | `bun --bun vitest run packages/core/src/plugin/PluginHost.test.ts`                                                         | all pass                                      |
| Gateway tests       | `bun --bun vitest run apps/gateway/src/Handlers.test.ts`                                                                   | all pass                                      |
| All                 | `bun run check`                                                                                                            | exit 0                                        |
| Gateway plugin list | `PORT=4398 bun run apps/gateway/src/main.ts &` then `bun apps/cli/src/main.ts plugin list --gateway http://127.0.0.1:4398` | a row starting `shell	builtin	active	tool shell` |

## Scope

**In scope** (the only files you should modify):

- `apps/gateway/src/Server.ts` (one line in `builtinPlugins`)
- `packages/core/src/plugin/PluginHost.ts` (the boot warning)
- `packages/core/src/plugin/PluginHost.test.ts` (one agent listing an unregistered tool, one assertion)
- `apps/gateway/src/Handlers.test.ts` (one assertion that the built-ins cover the assistant)

**Out of scope** (do NOT touch, even though they look related):

- `packages/tools/src/ShellTool.ts` — behaviour of the tool itself; plan 006 changes it.
- The assistant prompt text in `Server.ts:22-52`.
- `packages/core/src/plugin/ToolRegistry.ts` — the silent intersection at call time stays; the warning is at boot.
- Making the warning an error. A failed MCP server legitimately leaves an agent's `linear_*` pattern unmatched; that must not stop the gateway.

## Git workflow

- Branch: `fix/wire-shell-plugin`
- Commit style: conventional commits, e.g. `fix: host the shell tool plugin and warn when an agent names a tool nobody registered`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Host the plugin

In `apps/gateway/src/Server.ts`, change `builtinPlugins` to:

```ts
export const builtinPlugins = [
  builtin(fileToolsPlugin),
  builtin(shellToolPlugin),
  ...modelPlugins.map(builtin),
  builtin(assistantPlugin),
];
```

**Verify**: `bun run typecheck` → exit 0. Then start a gateway on port 4398 (command table) and run `plugin list` against it → a `shell` row with `tool shell`, and the `assistant` row unchanged. Kill the gateway.

### Step 2: Warn at boot about unmatched tool names

In `packages/core/src/plugin/PluginHost.ts`, add `toolMatches` to the `@magentic/plugin` import, and directly after the boot `yield* rebuild;` add:

```ts
// A tool an agent names that no plugin registered is a typo, a failed
// plugin, or a server that did not connect; say so once, here.
const registered = (yield * tools.values).map((entry) => entry.tool.name);
const hidden = new Set(options.disabledTools ?? []);
for (const agent of (yield * Ref.get(agents)).values()) {
  for (const pattern of agent.tools) {
    const matched = registered.some((name) => toolMatches(pattern, name));
    if (!matched && !hidden.has(pattern)) {
      yield *
        Effect.logWarning(`agent ${agent.name} lists tool ${pattern}, which no plugin registered`);
    }
  }
}
```

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0

### Step 3: Test the warning

In `packages/core/src/plugin/PluginHost.test.ts`, change the `agentsPlugin` (lines 75-89) so the `helper` agent's tools are `["echo", "hidden", "missing_*"]`, and in the test `"agents come from transforms and the registry still registers at runtime"` change the assertion `assert.deepStrictEqual([...found.tools], ["echo", "hidden"]);` to `["echo", "hidden", "missing_*"]`. Then add a new test in the same `layer(host([...]))("PluginHost", …)` block that captures the boot warning. The test layer is built before tests run, so capture logs by building a second host inside the test:

```ts
it.effect("warns at boot about a tool no plugin registered", () =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      lines.push(String(message));
    });
    yield* Layer.build(host([echoPlugin("echo"), agentsPlugin])).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
    );
    assert.isTrue(lines.some((line) => line.includes("helper lists tool missing_*")));
    assert.isFalse(lines.some((line) => line.includes("lists tool hidden")));
  }),
);
```

Add `Logger` to the `effect` import. If `Logger.make` or `Logger.layer` are spelled differently in the installed rc, look in `node_modules/effect/dist/Logger.d.ts` for the constructor that takes a function of `{ message }` and the layer that replaces loggers, and use those; do not invent names.

**Verify**: `bun --bun vitest run packages/core/src/plugin/PluginHost.test.ts` → all pass, one more test than before

### Step 4: Pin the gateway's built-ins to the assistant

Append to `apps/gateway/src/Handlers.test.ts`, at file end, outside any `layer(...)` block (add `describe`/`it` to the `@effect/vitest` import if not already there from plan 002):

```ts
import { assistant, builtinPlugins } from "./Server.ts";

describe("built-in plugins", () => {
  it("host a plugin for every tool the assistant lists", () => {
    const ids = new Set(builtinPlugins.map((loaded) => loaded.plugin.id));
    assert.isTrue(ids.has("file-tools"));
    assert.isTrue(ids.has("shell"));
    assert.isTrue(assistant.tools.includes("shell"));
  });
});
```

Move the import up with the other `./` imports.

**Verify**: `bun --bun vitest run apps/gateway/src/Handlers.test.ts` → all pass

### Step 5: Full check

**Verify**: `bun run check` → exit 0

## Test plan

- `PluginHost.test.ts`: the boot warning fires for `missing_*` and not for the config-disabled `hidden`.
- `Handlers.test.ts`: `builtinPlugins` contains the `shell` plugin id.
- Manual: `plugin list` against a running gateway shows `shell` active.
- Pattern: the existing `it.effect` tests in each file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "builtin(shellToolPlugin)" apps/gateway/src/Server.ts` → 1 match
- [ ] `grep -n "which no plugin registered" packages/core/src/plugin/PluginHost.ts` → 1 match
- [ ] `bun --bun vitest run packages/core/src/plugin/PluginHost.test.ts` passes with the new test
- [ ] `bun --bun vitest run apps/gateway/src/Handlers.test.ts` passes with the new test
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only in-scope files (plus the pre-existing uncommitted `packages/mcp` work)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `builtinPlugins` in `Server.ts` no longer matches the excerpt (someone already wired shell, or restructured the list).
- Starting the gateway fails after Step 1 with a `ChildProcessSpawner` or `WorkspaceRoot` "service not found" error — the host's provided layers changed; report rather than adding layers.
- The logger capture in Step 3 cannot be made to work with the installed `Logger` API after consulting `Logger.d.ts`; report the API you found.
- Plan 002 has not landed and the operator has not explicitly said to proceed anyway.

## Maintenance notes

- The warning runs once at boot. `configAgentsPlugin` rebuilds agents on SIGHUP or file watch; a later change may want to re-run the check on rebuild (throttled), which is why it is a self-contained block.
- Reviewers: the shell tool runs commands as the gateway user under `Policy.layerAllowAll`; confirm plan 002's loopback default is in place on the same branch or already merged.
- Deferred: a `magentic config check` command that prints the resolved agents → tools → plugins (direction finding DIR-06).
