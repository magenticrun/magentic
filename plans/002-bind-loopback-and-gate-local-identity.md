# Plan 002: The gateway listens on loopback by default, and exposing local identity on a network needs an explicit acknowledgement

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- apps/gateway/src/Server.ts apps/gateway/src/Handlers.test.ts apps/cli/src/Gateway.ts docs/identity.md docs/harness.md README.md`
> `apps/gateway/src/Server.ts` is EXPECTED to differ from `0f690ca` in the
> working tree: an uncommitted change adds `import { mcpPlugin }` and a
> `const mcp = builtin(mcpPlugin, config.mcpServers);` line inside `HostLayer`.
> That is fine. Any other difference from the "Current state" excerpts is a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (001 recommended first so the change is gated)
- **Category**: security
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

The gateway has no request authentication yet. That is a documented phase-1 decision: `docs/harness.md:86-87` says the `Authentication` middleware is planned, and `docs/identity.md:33` records that the local identity provider is "dev mode only, gated by `IDENTITY_LOCAL=true`". The code has drifted from that decision in two ways. First, no `IDENTITY_LOCAL` gate exists anywhere (`grep -rn IDENTITY_LOCAL apps packages` returns nothing); `Identity.layerLocal` is wired unconditionally and every request is resolved to the gateway process's own `USER`. Second, the HTTP server is started without a `hostname`, so Bun binds every interface. Together: anyone who can reach port 4321 (the default, and the port the CLI auto-starts an embedded gateway on) can run agents with `fs:write` tools as the gateway user, with `Policy.layerAllowAll` allowing every call. After plan 003 lands, that includes arbitrary shell commands. Binding loopback by default is the cheap control for the whole pre-authentication period, and a non-loopback bind should require the acknowledgement the identity doc already names.

## Current state

- `apps/gateway/src/Server.ts:132-146` (working tree) — the server layer and the `PORT` config:

  ```ts
  /** The whole gateway on one port. Building the layer starts serving. `quiet` drops request logs. */
  export const layerServer = (port: number, options: { readonly quiet?: boolean } = {}) =>
    HttpRouter.serve(AllRoutes, {
      disableLogger: options.quiet === true,
      disableListenLog: options.quiet === true,
    }).pipe(
      // Bun closes a request that sends nothing for ten seconds; compacting a
      // conversation waits on the model longer than that. 255 is Bun's most.
      Layer.provide(BunHttpServer.layer({ port, idleTimeout: 255 })),
      Layer.provide([BunServices.layer, FetchHttpClient.layer]),
    );

  /** `Layer.launch` this to run the gateway on `PORT`. */
  export const HttpServerLayer = Layer.unwrap(
    Effect.map(Config.port("PORT").pipe(Config.withDefault(4321)), layerServer),
  );
  ```

- `apps/gateway/src/Server.ts:63-65` — how a config value with a default is read in this file (match this style):

  ```ts
  /** Directory the file tools may touch. Defaults to where the gateway was started. */
  const workspaceRoot = Config.string("MAGENTIC_WORKSPACE").pipe(Config.withDefault(process.cwd()));
  ```

- `apps/gateway/src/Server.ts:105` — the admission layer, wired unconditionally:

  ```ts
  const AdmissionLayer = Layer.mergeAll(
    Identity.layerLocal,
    Policy.layerAllowAll,
    Audit.layerMemory,
  );
  ```

- `apps/cli/src/Gateway.ts:38-45` — the CLI's embedded gateway calls `layerServer(port, { quiet: true })`; it only does so when the configured URL's hostname is `localhost` or `127.0.0.1` (`isLocal`, line 20). This caller must keep working unchanged.
- `BunHttpServer.layer` accepts Bun's serve options, including `hostname` (`ServeOptions` in `@effect/platform-bun/dist/BunHttpServer.d.ts:38` is `Bun.Serve.HostnamePortServeOptions & …`).
- `docs/identity.md:33` — the row for `LocalSubject`: "dev mode only, gated by `IDENTITY_LOCAL=true`". `docs/identity.md:197` lists `IDENTITY_LOCAL=true  dev only` under environment variables.
- `docs/harness.md:86-87`:

  ```
  Everything except `health` and the login RPCs will sit behind the `Authentication` middleware
  (`RpcMiddleware`, see identity.md).
  ```

- Errors in this codebase are `Schema.TaggedError` classes; see `apps/gateway/src/Plugins.ts:12-15` (`GatewayConfigError` with `file` and `message`). Never `throw`.
- Config is read through `Config`, never `process.env` (CLAUDE.md).

## Commands you will need

| Purpose                            | Command                                                                                                                | Expected on success                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Typecheck                          | `bun run typecheck`                                                                                                    | exit 0                                            |
| Lint                               | `bun run lint`                                                                                                         | exit 0                                            |
| Tests                              | `bun run test`                                                                                                         | all pass                                          |
| All                                | `bun run check`                                                                                                        | exit 0                                            |
| Start a gateway for a manual check | `PORT=4398 bun run apps/gateway/src/main.ts & echo $!`                                                                 | prints a pid; kill it with `kill <pid>` when done |
| Wait for it                        | `curl -s --retry 15 --retry-connrefused --retry-delay 1 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4398/health` | `204`                                             |
| Which address it bound             | `lsof -nP -iTCP:4398 -sTCP:LISTEN`                                                                                     | one line containing `127.0.0.1:4398`              |

## Scope

**In scope** (the only files you should modify):

- `apps/gateway/src/Server.ts`
- `apps/gateway/src/Handlers.test.ts` (append one test for the pure helper)
- `docs/identity.md` (the `LocalSubject` row and the env var block)
- `docs/harness.md` (one sentence after line 87)
- `README.md` (one line in Develop)

**Out of scope** (do NOT touch, even though they look related):

- `apps/cli/src/Gateway.ts` and `apps/cli/src/Cli.ts` — the embedded gateway must keep calling `layerServer(port, { quiet: true })`; do not add a hostname there.
- `packages/identity` — no new credential kinds; real authentication is direction finding DIR-01, a separate design.
- `apps/gateway/src/Handlers.ts` — the `USER`-based caller stays until sessions exist.

## Git workflow

- Branch: `fix/bind-loopback`
- Commit style: conventional commits, e.g. `fix: bind the gateway to loopback unless told otherwise`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the host config and the acknowledgement check

In `apps/gateway/src/Server.ts`, next to `workspaceRoot`, add:

```ts
/** Address the gateway listens on. Loopback until authentication exists; see docs/identity.md. */
const listenHost = Config.string("MAGENTIC_HOST").pipe(Config.withDefault("127.0.0.1"));

/** Whether the operator accepted that local identity trusts every caller on this network. */
const localIdentityAcknowledged = Config.boolean("IDENTITY_LOCAL").pipe(Config.withDefault(false));

export class UnsafeBind extends Schema.TaggedError<UnsafeBind>()("UnsafeBind", {
  host: Schema.String,
  message: Schema.String,
}) {}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Local identity resolves every caller to this process's user and policy allows
 * everything, so a bind beyond loopback needs saying so out loud.
 */
export const checkBind = (
  host: string,
  acknowledged: boolean,
): Effect.Effect<string, UnsafeBind> =>
  LOOPBACK.has(host) || acknowledged
    ? Effect.succeed(host)
    : Effect.fail(
        new UnsafeBind({
          host,
          message:
            `MAGENTIC_HOST=${host} would expose the gateway with local identity (every caller is ` +
            `this user) and no authentication. Keep MAGENTIC_HOST=127.0.0.1, or set ` +
            `IDENTITY_LOCAL=true to accept that on this network.`,
        }),
      );
```

Add `Schema` to the existing `import { Config, Effect, Layer } from "effect";` line.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Pass the hostname to the server

Change `layerServer` so its options carry the host, defaulting to loopback, and `HttpServerLayer` reads and checks it:

```ts
/** The whole gateway on one port. Building the layer starts serving. `quiet` drops request logs. */
export const layerServer = (
  port: number,
  options: { readonly quiet?: boolean; readonly hostname?: string } = {},
) =>
  HttpRouter.serve(AllRoutes, {
    disableLogger: options.quiet === true,
    disableListenLog: options.quiet === true,
  }).pipe(
    // Bun closes a request that sends nothing for ten seconds; compacting a
    // conversation waits on the model longer than that. 255 is Bun's most.
    Layer.provide(
      BunHttpServer.layer({ port, hostname: options.hostname ?? "127.0.0.1", idleTimeout: 255 }),
    ),
    Layer.provide([BunServices.layer, FetchHttpClient.layer]),
  );

/** `Layer.launch` this to run the gateway on `PORT`, listening on `MAGENTIC_HOST`. */
export const HttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.port("PORT").pipe(Config.withDefault(4321));
    const hostname = yield* checkBind(yield* listenHost, yield* localIdentityAcknowledged);
    return layerServer(port, { hostname });
  }),
);
```

`Layer.unwrap` accepts an effect that can fail; `main.ts` launches the layer with `BunRuntime.runMain`, which prints the failure and exits non-zero. Do not catch `UnsafeBind`.

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0

### Step 3: Prove the bind manually

Run, in this order, killing each gateway after its check:

1. `PORT=4398 bun run apps/gateway/src/main.ts &` then the curl wait command → `204`, then `lsof -nP -iTCP:4398 -sTCP:LISTEN` → the line shows `127.0.0.1:4398` and not `*:4398`.
2. `MAGENTIC_HOST=0.0.0.0 PORT=4398 bun run apps/gateway/src/main.ts; echo "exit $?"` → the process exits non-zero within a few seconds and the output contains `IDENTITY_LOCAL=true`.
3. `IDENTITY_LOCAL=true MAGENTIC_HOST=0.0.0.0 PORT=4398 bun run apps/gateway/src/main.ts &` then curl → `204`, `lsof` shows `*:4398`. Kill it.

**Verify**: all three outcomes as stated.

### Step 4: Cover the helper in the existing gateway test file

Append to `apps/gateway/src/Handlers.test.ts`, at the end of the file, outside any `layer(...)` block:

```ts
import { checkBind } from "./Server.ts";

describe("checkBind", () => {
  it.effect("accepts loopback without acknowledgement", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* checkBind("127.0.0.1", false), "127.0.0.1");
      assert.strictEqual(yield* checkBind("localhost", false), "localhost");
    }),
  );
  it.effect("refuses another address until IDENTITY_LOCAL acknowledges it", () =>
    Effect.gen(function* () {
      const refused = yield* checkBind("0.0.0.0", false).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "UnsafeBind");
      assert.strictEqual(yield* checkBind("0.0.0.0", true), "0.0.0.0");
    }),
  );
});
```

Move the import to the top of the file with the other `./` imports, and add `describe` and `it` to the existing `import { assert, layer } from "@effect/vitest";` line (`import { assert, describe, it, layer } from "@effect/vitest";`). Importing `./Server.ts` in a test only evaluates module-level layer definitions; nothing starts serving until a layer is built.

**Verify**: `bun --bun vitest run apps/gateway/src/Handlers.test.ts` → all pass, 2 more tests than before

### Step 5: Bring the docs in line

- `docs/identity.md:33`: change the `LocalSubject` row's "Verified by" cell to: `trusted as-is; the gateway binds loopback unless IDENTITY_LOCAL=true accepts a wider MAGENTIC_HOST`.
- `docs/identity.md` env var block (around line 197): change `IDENTITY_LOCAL=true                      dev only` to `IDENTITY_LOCAL=true                      accept local identity beyond loopback (dev only)` and add a line `MAGENTIC_HOST=127.0.0.1                  listen address; loopback by default`.
- `docs/harness.md`: after the sentence ending `(RpcMiddleware, see identity.md).` on line 87, add: `Until it exists the gateway listens on loopback (MAGENTIC_HOST, default 127.0.0.1); binding wider needs IDENTITY_LOCAL=true.`
- `README.md` Develop section: after the `bun run dev` line's comment, nothing changes; add one sentence after the code block: `The gateway listens on 127.0.0.1; set MAGENTIC_HOST to bind elsewhere (see docs/identity.md).`

**Verify**: `grep -c "MAGENTIC_HOST" docs/identity.md docs/harness.md README.md` → each file reports at least 1

### Step 6: Full check

**Verify**: `bun run check` → exit 0

## Test plan

- New tests (Step 4, appended to the existing `apps/gateway/src/Handlers.test.ts`): loopback accepted without the flag; `0.0.0.0` refused with `UnsafeBind`; `0.0.0.0` accepted with the flag.
- Manual (Step 3): the three process runs. Record their output in your report.
- Pattern to follow: the existing `it.effect` tests in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n 'hostname: options.hostname ?? "127.0.0.1"' apps/gateway/src/Server.ts` → 1 match
- [ ] `grep -n "IDENTITY_LOCAL" apps/gateway/src/Server.ts` → at least 1 match
- [ ] `bun --bun vitest run apps/gateway/src/Handlers.test.ts` passes with the two new tests
- [ ] Step 3 outcomes observed (loopback by default; refusal without the flag; wide bind with it)
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only in-scope files (plus the pre-existing uncommitted `packages/mcp` work, which is not yours)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `BunHttpServer.layer` rejects `hostname` at typecheck — the installed platform version differs from the one read at planning time.
- `Config.boolean` does not exist under that name in the installed `effect` (check `node_modules/effect/dist/Config.d.ts`); report the available spelling instead of inventing one.
- The embedded gateway in `apps/cli/src/Gateway.ts` stops working (`bun apps/cli/src/main.ts agents` with no gateway running should still list agents).
- Step 3's `lsof` shows `*:4398` for the default run — the hostname is not reaching Bun; do not work around it by editing the CLI.

## Maintenance notes

- When real authentication lands (direction finding DIR-01), `checkBind` should key on "an authenticating identity provider is configured" rather than the flag, and this plan's docs sentences get replaced.
- Reviewers: confirm no code path passes `hostname: "0.0.0.0"` implicitly; the CLI must never bind wide.
- Deferred on purpose: a bearer shared secret for `/rpc`. It is a bigger change and belongs with sessions.
