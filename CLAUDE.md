# magentic

Bun workspace, Effect-native. Use `bun`, never npm/pnpm/yarn. Packages import each other by name (`@magentic/core`), never by relative path across package boundaries.

## Commands

- `bun run check` runs typecheck, lint, and tests. Run it before claiming work is done.
- `bun run lint` is oxlint plus an oxfmt format check. `bun run format` applies both. Config lives in `.oxlintrc.json` and `.oxfmtrc.json`; rules are adapted from the Effect repo's own `packages/tools/oxc/oxlintrc.json`, plus the local anti-slop plugin in `tools/oxlint/anti-slop` (no `unknown` in signatures, no unjustified `as`, no `typeof` dispatch; every type assertion needs a `SAFETY:` comment stating the checked invariant).
- `bun run test` runs vitest on the Bun runtime (`bun --bun vitest run`) across every package. Do not use `bun test`; the suite is written with `@effect/vitest` and needs vitest as the runner.
- `bun run dev` starts the gateway with reload.

## Effect

This codebase targets Effect 4 (currently `4.0.0-rc.112`, pinned exactly in the root catalog). Effect 4 differs from Effect 3 in ways that matter, so do not write from memory.

- The reference checkout is at `~/references/effect`. Start with `LLMS.md`, then the worked examples under `ai-docs/src`, then `migration/v3-to-v4.md` when something you expect from v3 is missing.
- The checkout tracks `main` and can be ahead of the installed rc. When a name from the checkout fails to typecheck, look in `node_modules/effect/dist/*.d.ts` for the installed spelling (for example `Config.port` is lowercase in rc.112).
- Services: `class X extends Context.Service<X, { ... }>()("magentic/<pkg>/X")` with static layers on the class (`layer`, `layerMemory`, `layerNoDeps`). Service ids are `magentic/<package>/<Name>`.
- Errors: `Schema.TaggedError`. Use a `reason` union when one service has many failure modes. Never throw.
- Validation and domain models: `Schema.Class`, never hand-rolled parsing. Runtime checks come from `Predicate`.
- Functions returning effects: `Effect.fn("Service.method")` for traced boundaries, `Effect.fnUntraced` on hot paths. Do not wrap a bare `Effect.gen` in a function.
- HTTP: the `HttpApi` definition lives in `@magentic/protocol`; handlers live in the gateway via `HttpApiBuilder.group`. Test handlers with `HttpApiTest.groups`, not a live server.
- Tests: `layer(SomeLayer)("name", (it) => it.effect(...))` from `@effect/vitest`, beside the code as `*.test.ts`.
- Time comes from `DateTime` and `Clock`, config from `Config`, never `Date.now()` or `process.env` directly.

## Conventions

- One `tsconfig.base.json`; packages only extend it. Strict mode stays on.
- No build step. Bun runs `src/index.ts` directly; `exports` point at source.
- Shared dependency versions live in the root `catalog`; packages reference them as `catalog:`.
- The gateway is the only place identity, policy, and audit are wired together. Surfaces stay thin and only depend on `@magentic/protocol`.
