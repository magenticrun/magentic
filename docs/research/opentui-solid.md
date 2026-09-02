# OpenTUI + Solid for the magentic CLI

Research date: 2026-09-01. Question: should `magentic run <agent>` and `magentic chat <agent>` render
their streaming terminal UI with `@opentui/core` and `@opentui/solid`?

Everything below was checked against the `anomalyco/opentui` repository (formerly `sst/opentui`;
the `sst` raw URLs still serve the same files and the npm `homepage` points at `anomalyco`), the
npm registry, the published tarballs installed into a scratch directory, and a smoke test run on
this machine (Bun 1.4.0, macOS arm64). Claims that could not be checked are marked **unverified**.

Short answer: yes, with guardrails. See section 10.

## 1. What OpenTUI is

- "OpenTUI is a library to build terminal user interfaces." Written in Zig with TypeScript bindings;
  ships React and Solid renderers, flexbox layout, selects, inputs, scroll boxes, plus sound, images
  and 3D. (README, https://github.com/anomalyco/opentui/blob/main/README.md)
- Maintainer: the `anomalyco` GitHub org (the company behind opencode). Repo stats on 2026-09-01:
  13,204 stars, 136 open issues, default branch `main`, last push 2026-09-01T15:58Z
  (`gh api repos/anomalyco/opentui`).
- License: MIT (README "OpenTUI is licensed under the MIT License"; `npm view @opentui/core license`).
- Packages: `@opentui/core`, `@opentui/react`, `@opentui/solid`, plus `@opentui/keymap`,
  `@opentui/qrcode`, `@opentui/ssh`, `@opentui/three` (repo `package.json` `publish:*` scripts).
- Current version: `@opentui/core@0.5.10` and `@opentui/solid@0.5.10`, both published
  2026-09-01T16:09Z. First publish 2025-08-13 (core) and 2025-08-18 (solid).
  (`npm view @opentui/core time`, `npm view @opentui/solid time`)
- Cadence: `v0.5.0` on 2026-08-03, then `0.5.1` … `0.5.10` by 2026-09-01, i.e. ten patch releases in
  four weeks, plus `0.0.0-<date>-<sha>` nightlies between them (`gh release list`,
  `npm view @opentui/core time`). `v0.4.5` was 2026-07-17, `v0.4.1` 2026-06-11.
- Stated maturity: the README makes no alpha/beta claim. The version line is `0.x`. The GitHub
  "about" text seen through Context7 says the project is "currently in development, aiming to be a
  foundational TUI framework for opencode and terminaldotshop"; the current
  `gh api` description is just "OpenTUI is a library to build terminal user interfaces (TUI)", so the
  "in development" wording is **unverified** as current.
- Adopters with evidence:
  - README line 20: "OpenCode uses OpenTUI in production for millions of users."
  - opencode pins `@opentui/core`, `@opentui/keymap`, `@opentui/solid` at `0.4.5` in its root
    `package.json` catalog and uses the Solid binding
    (https://github.com/anomalyco/opencode/blob/dev/package.json,
    https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/app.tsx).
  - Kilo Code (`Kilo-Org/kilocode`) forks the same TUI and pins `0.4.5`.
  - `kitlangton/ghui` and `magnitudedev/magnitude` use the React binding together with Effect.

## 2. Bun requirement and platform support

- Native core: Zig library loaded over FFI. `@opentui/core` depends on `bun-ffi-structs@0.3.1`
  (`npm view @opentui/core dependencies`). The runtime-support doc says "Importing Core does not call
  native functions. APIs such as `createCliRenderer()` load the native library and need experimental
  FFI." (`packages/web/src/content/docs/getting-started/runtime-support.mdx`)
- Bun: "Bun 1.3.0 or later; Bun loads the matching optional native package." (same doc). The README
  says development needs Bun 1.3.0+ and Zig 0.16.0. The repo `packages/core/package.json` declares
  `"engines": { "bun": ">=1.3.0" }` (Context7 excerpt at 0.5.1); the published `0.5.10` tarball has no
  `engines` field at all (checked in the installed `node_modules/@opentui/core/package.json`).
- Node: "Node.js 26.4.0 or later; use ECMAScript modules (ESM) and `--experimental-ffi`." CommonJS
  `require("@opentui/core")` fails with `ERR_REQUIRE_ASYNC_MODULE`. Node acceptance CI runs on Linux
  x64 only. For Solid specifically: "Bun can transform Solid TSX directly through package preloading,
  whereas Node.js environments require that Solid TSX be pre-compiled"
  (`packages/web/src/content/packages/opentui-solid.mdx`), and `@opentui/solid/preload` and
  `@opentui/solid/bun-plugin` "publish Node.js stubs that throw during import"
  (`docs/reference/package-entrypoints.mdx`). So the Solid path is Bun-only unless we add a Babel
  build step.
- Platforms: eight native targets in `packages/core/src/zig/build.zig` `SUPPORTED_TARGETS`, shipped
  as optional dependencies `@opentui/core-{darwin,linux,win32}-{x64,arm64}` and
  `linux-{x64,arm64}-musl` (`npm view @opentui/core optionalDependencies`). "Current Bun Core tests
  run on macOS arm64, Linux x64, and Windows x64." and "An available artifact does not prove runtime
  parity on every published target." (runtime-support.mdx). Alpine needs `libstdc++ libgcc` and
  `OPENTUI_LIBC=musl` set before the first Core import.

## 3. How `@opentui/solid` works (JSX transform, no build step)

- Required tsconfig: `"jsx": "preserve"`, `"jsxImportSource": "@opentui/solid"`
  (`packages/solid/README.md`; opencode's `packages/tui/tsconfig.json` uses exactly these on top of
  `@tsconfig/bun`).
- Required runtime transform under Bun: `bunfig.toml` `preload = ["@opentui/solid/preload"]`.
  The published `scripts/preload.js` is two lines: it imports `ensureSolidTransformPlugin` from
  `./solid-plugin.js` and calls it. That registers a `Bun.plugin` named `bun-plugin-solid` whose
  `onLoad` filter matches every `.[cm]?[jt]sx` file outside `node_modules`, runs
  `transformSolidSource` (Babel with `babel-preset-solid`, `moduleName: "@opentui/solid"`,
  `generate: "universal"`) and returns JS. It also rewrites `solid-js/dist/server.js` to
  `dist/solid.js` and the store equivalent so Bun's `node` export condition does not pick Solid's
  non-reactive server build. (`@opentui/solid@0.5.10/scripts/solid-plugin.js`)
- `bun run file.tsx` with no build step: verified. `bun probe.tsx` in the scratch install rendered a
  scrollbox and an approval box and reacted to a mocked `y` key press; wall time 0.40 s including
  the Babel transform.
- Without the preload: Bun's built-in JSX transform still compiles against
  `@opentui/solid/jsx-runtime` (a real `jsx()`/`createComponent` runtime exists in the package), the
  program runs without error, but reactive children like `{text()}` are evaluated once and the text
  stays empty. Verified. This is a silent failure mode worth a comment in the entry file.
- Alternative to a root `bunfig.toml`: a plain `.ts` entry can call
  `ensureSolidTransformPlugin()` from `@opentui/solid/bun-plugin` and then dynamically import the
  `.tsx` module. Verified (`entry.ts` in the scratch dir rendered correctly with `bunfig.toml`
  removed). Static imports are hoisted, so the `.tsx` import must be dynamic.
- Interaction with this repo's tsconfig: `tsc -p` with `target ESNext`, `module Preserve`,
  `moduleResolution bundler`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`, `allowImportingTsExtensions`,
  plus the two JSX options, exits 0 on the sample component. OpenTUI's own
  `packages/solid/examples/tsconfig.json` sets `verbatimModuleSyntax: true` with `jsx: preserve`.
  `erasableSyntaxOnly` only forbids enums/namespaces/parameter properties in our sources; JSX is
  unaffected.

## 4. Rendering model

- Renderer: `const renderer = await createCliRenderer(config)`; `render(node, rendererOrConfig?)`
  from `@opentui/solid` returns `Promise<void>` that "resolves after the initial mount. It does not
  return a disposer. When you pass a renderer, Solid adopts it but does not take application
  ownership. The code that created that renderer must destroy it." Renderer destruction disposes
  the Solid root and runs `onCleanup`. (`docs/bindings/solid.mdx`, `@opentui/solid@0.5.10/index.d.ts`)
- Config defaults read from `packages/core/src/renderer.ts` (lines 1180-1291 at `main`):
  `exitOnCtrlC` true; `exitSignals` `[SIGINT, SIGTERM, SIGQUIT, SIGABRT, SIGHUP, SIGPIPE, SIGBREAK,
SIGBUS]`; `targetFps` 30; `maxFps` 60; `useMouse` true; `enableMouseMovement` true; `autoFocus`
  true; `screenMode` `"alternate-screen"` (also `"main-screen"`, `"split-footer"`);
  `externalOutputMode` `"passthrough"` (or `"capture-stdout"`, only with split-footer);
  `consoleMode` `"console-overlay"`; `clearOnShutdown` true; `onDestroy` callback; `stdin`/`stdout`
  injectable; resize debounce 100 ms.
- Components (Solid intrinsics, snake_case for multi-word): `text`, `box`, `scrollbox`,
  `ascii_font`, `input`, `textarea`, `select`, `tab_select`, `code`, `line_number`, `diff`, and
  text modifiers `span`, `strong`/`b`, `em`/`i`, `u`, `br`, `a` (`packages/solid/README.md`).
  Component docs also cover `markdown`, `slider`, `text-table`, `image`, `qr-code`,
  `embedded-terminal`, `frame-buffer`, `scrollbar` (`docs/components/*.mdx`).
- Layout: Yoga flexbox ("2. Yoga computes layout", `docs/core-concepts/rendering-pipeline.mdx`;
  `@opentui/core/yoga` entry point).
- Focus: "Each renderer tracks at most one focused renderable." Input, Textarea, Select, TabSelect,
  ScrollBox and ScrollBar are focusable by default; Box needs `focusable: true`. "OpenTUI Core has no
  automatic Tab traversal or focus-order property. Your application must choose the next renderable
  and call `focus()`." (`docs/core-concepts/interaction.mdx`)
- Keyboard: `useKeyboard(handler, { release? })` in Solid; global listeners run before the focused
  renderable; `key.stopPropagation()` / `key.preventDefault()`; Kitty keyboard protocol supported;
  paste via `usePaste`. (`docs/core-concepts/keyboard.mdx`, `docs/bindings/solid.mdx`)
- Mouse: on by default, `onMouseDown/Up/Move/Drag/Scroll/Over/Out`, bubbling with
  `stopPropagation`. (`interaction.mdx`)
- Resize: `SIGWINCH` listener only when stdout is `process.stdout`; `onResize` and
  `useTerminalDimensions()` hooks; the retained tree survives a resize. (`renderer.ts` line 1238,
  `rendering-pipeline.mdx` "Resize behavior")
- Exit: `renderer.destroy()` is "synchronous and idempotent"; it removes signal/process listeners,
  restores `stdout.write`, disables raw mode, exits the alternate screen, shows the cursor, then
  calls `onDestroy`. `SIGKILL` and a direct `process.exit()` bypass this.
  (`docs/core-concepts/lifecycle.mdx`)

## 5. Streaming updates into Solid

- Text children in the Solid binding are reactive, so the natural shape is a signal or store per
  run and `setText((t) => t + delta)` per `TextDelta`. Solid's `batch()` groups several writes into
  one update, and `createStore` + `produce` handle nested/array state (Solid store README via
  Context7 `/solidjs/solid`). The smoke test used `batch()` around a burst of deltas.
- Frame scheduling: renderable setters call `requestRender()`, which schedules a one-shot frame via
  `process.nextTick` (or `setTimeout` when under `minTargetFrameTime`); "Demand-driven scheduling
  coalesces repeated requests into a later frame." So many deltas per tick collapse into one frame
  at up to `targetFps` 30 / `maxFps` 60. (`packages/core/src/renderer.ts` `requestRender`,
  `rendering-pipeline.mdx`)
- Native diffing: "For changed cells, native code emits cursor movement, color state, attributes …
  An unchanged frame can emit no terminal bytes." (`rendering-pipeline.mdx`)
- Auto-follow: `<scrollbox stickyScroll stickyStart="bottom">` keeps the viewport pinned to the
  bottom while content grows, and releases when the user scrolls up (`ScrollBox.ts`
  `updateStickyState`, `docs/components/scrollbox.mdx`).
- 0.5.10 shipped "fix(core): preserve markdown during stream completion" (release notes), so the
  `markdown` renderable has a streaming mode; details **unverified** (not read).
- Throughput numbers for streaming text: none documented beyond the benchmark scripts
  (`packages/core/src/benchmark`), **unverified**.

## 6. Interplay with `effect/unstable/cli` and `BunRuntime.runMain`

Existing pattern in the wild (opencode, `packages/tui/src/app.tsx` at `dev`, Solid + Effect):

```ts
export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => createCliRenderer({ /* … */ exitOnCtrlC: false }) }),
        (renderer) => Effect.sync(() => destroyRenderer(renderer)),
      )
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      yield* Effect.tryPromise(async () => { await render(() => <ExitProvider …>…</ExitProvider>, renderer) })
      yield* Deferred.await(shutdown)
    }),
  )
})
```

`magnitudedev/magnitude` (`cli/src/platform/terminal-appearance.ts`) shows the other half:
`Effect.acquireRelease` around `renderer.on(...)`/`renderer.off(...)`, renderer events pushed into a
`Queue`, and a `Effect.forever(...).pipe(Effect.forkScoped)` consumer.

Conflicts to design around:

- Signals. `BunRuntime.runMain` is `NodeRuntime.runMain`, which registers `SIGINT`/`SIGTERM`
  listeners that interrupt the main fiber and, once the fiber exits, calls `process.exit(code)` if a
  signal was received (`@effect/platform-node-shared@4.0.0-rc.112/src/NodeRuntime.ts` lines 52-75).
  OpenTUI registers its own listeners for eight signals that call `renderer.destroy()`
  (`renderer.ts` 1181-1190, `lifecycle.mdx` "Signal handling"). Both sets run; that is harmless
  because `destroy()` is idempotent, but the clean shape is `exitOnCtrlC: false, exitSignals: []`
  so Effect interruption is the only shutdown path and the `acquireRelease` finaliser is the only
  caller of `destroy()`. The docs recommend exactly this when "the application or a server owns
  process shutdown".
- Ctrl+C has two paths: the `SIGINT` signal and a parsed keypress. With raw mode on, the terminal
  does not generate `SIGINT` for Ctrl+C; OpenTUI's key handler does when `exitOnCtrlC` is true. With
  it off, handle `key.ctrl && key.name === "c"` in `useKeyboard` and complete a `Deferred`.
- Console. Default `consoleMode: "console-overlay"` "replaces the global console with a
  `node:console.Console` whose output streams write to an internal capture" (`console.mdx`).
  Effect's `Console` service and default `Logger` write through `console.log`/`console.error`
  (`effect@4.0.0-rc.112/dist/Console.js` lines 236-615, `Logger.js`), so any `Effect.log` during the
  TUI would vanish into a hidden overlay. Set `consoleMode: "disabled"` (or env `OTUI_USE_CONSOLE=false`)
  and route logs to a file or stderr logger while the TUI is up.
- stdin/stdout. The renderer takes exclusive ownership of the stream objects
  (`rendererTracker.streamOwners`, `renderer.ts` 1285-1286), sets raw mode, and enters the alternate
  screen by default. Nothing else should write to stdout until `destroy()` returns; opencode writes
  its epilogue to `process.stdout` after the scope closes.
- Process-wide listeners. The renderer also adds `uncaughtException`, `unhandledRejection` and
  `warning` listeners that report but do not destroy (`renderer.ts` 1241-1244); they are removed in
  `destroy()`.
- Non-TTY. Nothing in the docs describes a headless fallback; a `magentic run` invoked from CI or a
  pipe should skip the TUI and print events as text. That is our decision, not an OpenTUI feature
  (**unverified** whether `createCliRenderer` degrades on a non-TTY stdout).

## 7. Testing

- Test renderer: `@opentui/core/testing` exports `createTestRenderer`, `mockInput`, `KeyCodes`;
  `@opentui/solid` exports `testRender(node, { width, height })` returning a `TestRendererSetup` with
  `renderOnce()`, `flush()`, `waitFor()`, `waitForFrame(predicate)`, `waitForVisualIdle()`,
  `captureCharFrame()`, `captureSpans()`, `resize()`, `mockInput.typeText/pressKey/pressBackspace`.
  (`docs/core-concepts/testing.mdx`, `docs/bindings/solid.mdx`, `index.d.ts`)
- Official examples use `bun:test`; opencode's `bunfig.toml` has `[test] preload = ["@opentui/solid/preload"]`.
  Vitest is not mentioned in the docs.
- Under `bun --bun vitest run` (vitest 4.1.11) verified:
  - Without a Vite Solid plugin the file fails to parse ("Unexpected JSX expression") because Vite
    honours `jsx: preserve`.
  - With `vite-plugin-solid@2.11.14` configured as
    `solid({ solid: { moduleName: "@opentui/solid", generate: "universal" }, ssr: false })`,
    `test.environment: "node"` (the plugin defaults vitest to jsdom, which is not installed) and
    `resolve.alias` mapping `solid-js` to `solid-js/dist/solid.js` and `solid-js/store` to
    `solid-js/store/dist/store.js`, the test passes: the streamed text appears, a mocked `y` key
    flips the approval line. Without the alias the same test fails because Vite's `node` condition
    resolves `solid-js` to `dist/server.js` (checked in `solid-js@1.9.12/package.json` `exports`).
  - The native FFI library loads fine inside vitest's forks pool on Bun.
- First-frame timing: state set in `onMount` lands on the second frame, so assert with
  `waitForFrame(...)` rather than one `renderOnce()`.

## 8. Lint and format

- oxlint parses TSX natively. The repo's own `.oxlintrc.json` (oxlint 1.81.0) ran on the sample
  component with no findings other than `eslint/no-console` in the probe script, which this repo
  already turns off for `apps/cli/**`. `oxfmt --check` (0.66.0) reports the file as formatted.
- OpenTUI itself lints with oxlint (`plugins: ["react", "typescript", "import"]`, with
  `react/react-in-jsx-scope` and `react/no-unknown-property` off) and formats with oxfmt
  (`anomalyco/opentui/.oxlintrc.json`, `.oxfmtrc.json`). We do not need the react plugin.
- Solid-specific rules: oxlint's `configuration_schema.json` lists `react`, `react-perf`,
  `jsx-a11y`, `vue` plugins and no Solid plugin; a code search for `eslint-plugin-solid` in
  `oxc-project/oxc` returns nothing. So `solid/reactivity` and `solid/no-destructure` (the rules that
  catch destructured `props` and untracked reads) have no oxlint equivalent (**unverified** beyond
  the schema and search). Mitigation: keep components tiny, never destructure `props`, read signals
  only inside JSX or `createEffect`, and cover behaviour with `testRender`.
- `typescript/consistent-type-imports` and `verbatimModuleSyntax` are compatible with Solid's
  transform output (the Babel transform runs on the source as written).

## 9. Constraints and risks

- API stability: `0.x` with ten patch releases in the last month and nightly builds; release notes
  are PR lists without "breaking" labels (`gh release view v0.5.0`, `v0.5.10`). opencode pins an
  exact older version (`0.4.5`) and excludes the `@opentui/*` packages from its
  `minimumReleaseAge` install rule. Pin exact versions in the root catalog and bump deliberately.
- Peer pins: `@opentui/solid` requires `solid-js` `1.9.12` exactly (peer dependency; docs say
  "Solid 1.9.12 exactly"). `web-tree-sitter@0.25.10` is a peer of core (only needed for `code`
  highlighting; Bun install warns but does not fail without it, **unverified** for the warning text).
- Install size: `npm view dist.unpackedSize` is 13.6 MB for core and 0.33 MB for solid. A fresh
  `bun add @opentui/core @opentui/solid solid-js` produced a 78 MB `node_modules` (102 packages):
  core 13 MB, `@babel/*` 11 MB (the Solid transform runs Babel at startup), `core-darwin-arm64`
  5.3 MB containing `libopentui.dylib` (5.5 MB). Only the host platform's native package is
  installed. No postinstall script and no network download at runtime; the binary arrives as an
  optional dependency.
- Bun lock-in: the Solid preload and bun-plugin entry points are Bun-only; Node requires 26.4+,
  `--experimental-ffi`, and a Babel build. The CLI is already `bun src/main.ts`, so this is
  consistent with the repo, but it rules out ever shipping the TUI on Node without a build step.
- Monorepo + no build step: a root `bunfig.toml` `preload` applies to every package started from
  the repo root (gateway included), costing a Babel import at startup for nothing. Prefer
  registering the plugin from the CLI entry (section 3) or a per-package `bunfig.toml`; note that
  Bun reads `bunfig.toml` from the working directory, so the `bin` shebang path cannot rely on it.
- Test harness: vitest needs `vite-plugin-solid` and the `solid-js` alias at the root config; the
  alias is global but harmless because no other package uses Solid.
- Terminal compatibility: capability detection with a `TerminalCapabilities` snapshot, multiplexer
  detection (`tmux`, `zellij`, `screen`), Kitty keyboard, Sixel/Kitty/block images
  (`docs/reference/terminal-capabilities.mdx`). Default alternate screen means run output is not in
  scrollback after exit; `split-footer` + `writeSolidToScrollback` exists for a transcript-style UI
  (`docs/bindings/solid.mdx` "Scrollback writers"). Windows is a supported native target with Bun
  tests on x64 only.
- Accessibility: "OpenTUI does not create a browser accessibility tree. Supply visible focus state,
  keyboard alternatives, and text labels in your application." (`interaction.mdx`). No screen-reader
  support is documented.
- Global side effects: the renderer patches `global.requestAnimationFrame` /
  `cancelAnimationFrame` (`renderer.ts` 1294-1301) and, by default, the global `console`.
- Silent failure without the transform (section 3): a `.tsx` that loads without the plugin renders
  empty text and no error.

## 10. Recommendation and skeleton

Adopt `@opentui/solid` for `run` and `chat`, with these guardrails: exact catalog pins, Effect owns
the renderer lifecycle (`exitSignals: []`, `exitOnCtrlC: false`, `consoleMode: "disabled"`),
plugin registration from the `.ts` entry rather than a root `bunfig.toml`, a non-TTY plain-text
fallback, and `testRender`-based tests under vitest with `vite-plugin-solid`.

Layout:

```
apps/cli/
  package.json           add @opentui/core, @opentui/solid, solid-js (catalog:)
  tsconfig.json          add jsx + jsxImportSource
  src/main.ts            registers the Solid transform, defines commands (no JSX here)
  src/tui/Tui.ts         Effect wrapper: acquireRelease renderer, bridge Stream<RunEvent> -> store
  src/tui/RunView.tsx    Solid component: scrollbox transcript + approval prompt
  src/tui/RunView.test.tsx
vitest.config.ts         add vite-plugin-solid + solid-js alias
package.json             catalog entries + vite-plugin-solid devDependency
```

Root `package.json` additions (versions current on 2026-09-01):

```json
"catalog": {
  "effect": "4.0.0-rc.112",
  "@effect/platform-bun": "4.0.0-rc.112",
  "@opentui/core": "0.5.10",
  "@opentui/solid": "0.5.10",
  "solid-js": "1.9.12"
},
"devDependencies": { "vite-plugin-solid": "2.11.14" }
```

`apps/cli/package.json` dependencies:

```json
"dependencies": {
  "@effect/platform-bun": "catalog:",
  "@magentic/protocol": "workspace:*",
  "@opentui/core": "catalog:",
  "@opentui/solid": "catalog:",
  "effect": "catalog:",
  "solid-js": "catalog:"
}
```

`apps/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "preserve", "jsxImportSource": "@opentui/solid" },
  "include": ["src"]
}
```

`vitest.config.ts` (root):

```ts
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid({ solid: { moduleName: "@opentui/solid", generate: "universal" }, ssr: false })],
  resolve: {
    alias: {
      "solid-js/store": "solid-js/store/dist/store.js",
      "solid-js": "solid-js/dist/solid.js",
    },
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
  },
});
```

`apps/cli/src/main.ts` (excerpt; the `.tsx` import must stay dynamic so the plugin is registered first):

```ts
#!/usr/bin/env bun
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";
// Bun plugins only affect modules loaded after registration; keep every .tsx import dynamic.
ensureSolidTransformPlugin();

const run = Command.make(
  "run",
  { agent: Argument.string("agent"), input: Argument.string("input") },
  Effect.fn(function* ({ agent, input }) {
    const root = yield* magentic;
    const client = yield* makeClient(root.gateway);
    const runId = yield* client.agents.startRun({ path: { name: agent }, payload: { input } });
    const events = client.runs.events({ path: { id: runId } }); // Stream<RunEvent>
    if (!process.stdout.isTTY) return yield* printEvents(events);
    const { Tui } = yield* Effect.promise(() => import("./tui/Tui.ts"));
    return yield* Tui.run({ agent, events, decide: (id, verdict) => client.approvals.decide(...) });
  }),
);
```

`apps/cli/src/tui/Tui.ts` (shape; names of the Effect 4 queue/deferred helpers should be checked
against `node_modules/effect/dist/*.d.ts` before use):

```ts
export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createCliRenderer({ exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled" }),
        ),
        (r) => Effect.sync(() => r.destroy()),
      );
      const done = yield* Deferred.make<void>();
      renderer.once("destroy", () => Deferred.doneUnsafe(done, Effect.void));
      const { RunView, createRunStore } = yield* Effect.promise(() => import("./RunView.tsx"));
      const store = createRunStore(); // Solid createStore + setters
      yield* Stream.runForEach(input.events, (e) => Effect.sync(() => store.push(e))).pipe(
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        render(
          () =>
            RunView({
              store,
              onDecide: (id, v) => input.decide(id, v),
              onQuit: () => renderer.destroy(),
            }),
          renderer,
        ),
      );
      yield* Deferred.await(done);
    }),
  );
});
```

`apps/cli/src/tui/RunView.tsx` (verified shape from the smoke test):

```tsx
export const RunView = (props: RunViewProps) => {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onQuit();
    const pending = props.store.pendingApproval();
    if (pending && key.name === "y") props.onDecide(pending.id, "approve");
    if (pending && key.name === "n") props.onDecide(pending.id, "deny");
  });
  return (
    <box flexDirection="column" width="100%" height="100%">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" focused>
        <text>{props.store.transcript()}</text>
      </scrollbox>
      <Show when={props.store.pendingApproval()}>
        {(a) => (
          <box height={3} border>
            <text>
              Approve {a().tool} {a().summary}? [y/n]
            </text>
          </box>
        )}
      </Show>
    </box>
  );
};
```

`apps/cli/src/tui/RunView.test.tsx`:

```tsx
test("streams text and shows the approval prompt", async () => {
  const setup = await testRender(() => <RunView store={fixture} onDecide={noop} onQuit={noop} />, {
    width: 60,
    height: 12,
  });
  try {
    const frame = await setup.waitForFrame((f) => f.includes("Hello, stream"));
    expect(frame).toContain("Approve shell");
    setup.mockInput.pressKey("y");
    await setup.waitForFrame((f) => f.includes("approved"));
  } finally {
    setup.renderer.destroy();
  }
});
```

Open items before implementation: confirm the Effect 4 rc.112 spellings for `Deferred.doneUnsafe`,
`Stream.runForEach`, and `Effect.forkScoped` in `node_modules/effect/dist`; decide whether
`chat` uses `split-footer` + scrollback writers or the alternate screen; add a `web-tree-sitter`
dependency only if the `code` component is used.

## Sources

- https://github.com/anomalyco/opentui/blob/main/README.md
- https://github.com/anomalyco/opentui/blob/main/packages/solid/README.md
- https://github.com/anomalyco/opentui/blob/main/packages/core/README.md
- https://github.com/anomalyco/opentui/blob/main/packages/core/package.json
- https://github.com/anomalyco/opentui/blob/main/packages/solid/package.json
- https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderer.ts
- https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/ScrollBox.ts
- https://github.com/anomalyco/opentui/blob/main/packages/core/src/zig/build.zig
- https://github.com/anomalyco/opentui/blob/main/packages/solid/src/types/elements.ts
- https://github.com/anomalyco/opentui/blob/main/packages/solid/examples/tsconfig.json
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/getting-started/runtime-support.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/reference/package-entrypoints.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/bindings/solid.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/lifecycle.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/console.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/rendering-pipeline.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/keyboard.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/interaction.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/testing.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/renderer.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/scrollbox.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/ship/deploy.mdx
- https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/reference/terminal-capabilities.mdx
- https://github.com/anomalyco/opentui/blob/main/.oxlintrc.json and `.oxfmtrc.json`
- https://github.com/anomalyco/opentui/releases/tag/v0.5.0, https://github.com/anomalyco/opentui/releases/tag/v0.5.10
- `npm view @opentui/core` and `npm view @opentui/solid` (2026-09-01)
- Installed tarballs: `@opentui/core@0.5.10/package.json`, `@opentui/solid@0.5.10/scripts/preload.js`,
  `@opentui/solid@0.5.10/scripts/solid-plugin.js`, `@opentui/solid@0.5.10/jsx-runtime.js`,
  `@opentui/solid@0.5.10/index.d.ts`, `solid-js@1.9.12/package.json`
- https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/app.tsx
- https://github.com/anomalyco/opencode/blob/dev/packages/tui/tsconfig.json
- https://github.com/anomalyco/opencode/blob/dev/packages/tui/bunfig.toml
- https://github.com/anomalyco/opencode/blob/dev/package.json, https://github.com/anomalyco/opencode/blob/dev/bunfig.toml
- https://github.com/magnitudedev/magnitude/blob/main/cli/src/platform/terminal-appearance.ts
- https://github.com/kitlangton/ghui/blob/main/src/index.tsx
- `@effect/platform-node-shared@4.0.0-rc.112/src/NodeRuntime.ts`, `@effect/platform-bun@4.0.0-rc.112/src/BunRuntime.ts`,
  `effect@4.0.0-rc.112/dist/Console.js`
- Context7: `/anomalyco/opentui`, `/solidjs/solid`
- Local smoke test: `/private/tmp/claude-501/-Users-bvego-Projects-magentic-run/c9790b4f-9b56-438d-b604-dff046608d4b/scratchpad/otui`
  (`probe.tsx`, `entry.ts`, `probe.test.tsx`, `vitest.config.ts`, `tsconfig.json`)
