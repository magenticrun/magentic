# Plan 004: A conversation id can never become a path segment it should not be

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f690ca..HEAD -- packages/protocol/src/Conversation.ts packages/protocol/src/Run.ts packages/protocol/src/Api.ts packages/core/src/ConversationStore.ts apps/gateway/src/Handlers.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (existing ids are UUIDs; the pattern accepts them)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0f690ca`, 2026-09-02

## Why this matters

Conversation ids arrive from the client in `run` (`conversationId`) and in `getConversation`, `transcript`, `rename`, `removeConversation`, and `compact` (`id`), typed as plain `Schema.String`. The file-backed store joins the id into a path: `path.join(dir, id, "conversation.json")`, creates that directory recursively on `save`, and `remove` does `fs.remove(path.join(dir, id), { recursive: true })`. An id containing `../` therefore writes two JSON files (with caller-chosen content inside) anywhere the gateway user can write, and `remove` deletes any directory that contains a decodable `conversation.json` owned by the caller, which the write path can plant first. The gateway has no request authentication yet (plan 002 limits exposure to loopback), so this is reachable by anything on the box or, on a wide bind, on the network. The runner generates UUIDs for real conversations, so a strict pattern breaks nothing.

## Current state

- `packages/protocol/src/Conversation.ts:18-19`:

  ```ts
  export class Conversation extends Schema.Class<Conversation>("magentic/protocol/Conversation")({
    id: Schema.NonEmptyString,
  ```

- `packages/protocol/src/Run.ts:16`:

  ```ts
    conversationId: Schema.optional(Schema.String),
  ```

- `packages/protocol/src/Api.ts` — every conversation RPC payload uses `id: Schema.String` (lines 43, 48, 54, 59, 64: `getConversation`, `transcript`, `rename`, `removeConversation`, `compact`). `run` spreads `RunRequest.fields` (line 29), so fixing `Run.ts` fixes `run`.
- `packages/protocol/src/index.ts` re-exports every module with `export * from`, so a new export in `Conversation.ts` is public automatically.
- `packages/core/src/ConversationStore.ts:83-84` and `:118`, `:143-146` — the file layer:

  ```ts
  const infoFile = (id: string) => path.join(dir, id, "conversation.json");
  const historyFile = (id: string) => path.join(dir, id, "history.json");
  ```

  ```ts
  yield * fs.makeDirectory(path.join(dir, info.id), { recursive: true });
  ```

  ```ts
  const target = path.join(dir, id);
  if (yield * fs.exists(target)) {
    yield * fs.remove(target, { recursive: true });
  }
  ```

  `get` (`:93-102`) ends in `Effect.orElseSucceed(() => Option.none())`; `save`, `update`, `remove` map errors to `ConversationStoreError({ id, message })` (the class is defined near the top of the same file; read it before editing).

- `apps/gateway/src/Handlers.ts:71-76` — an unknown `conversationId` in `run` is allowed through and becomes the new conversation's id (the runner uses it verbatim).
- How a checked string schema is written in this codebase and in Effect 4: `Schema.String.check(Schema.isPattern(/…/))` (`isPattern(regExp, annotations?)` is declared at `node_modules/effect/dist/Schema.d.ts:5244`). Annotations follow the style in `packages/tools/src/FileTools.ts:44-46`: `.annotate({ description: "…" })`.
- `apps/gateway/src/Handlers.test.ts:214-262` — `"keeps conversations to list, replay, and delete"` exercises the conversation RPCs through `makeClient` (an `RpcTest` client, so payloads are still schema-validated) and asserts `ConversationNotFound` with `.pipe(Effect.flip)`.

## Commands you will need

| Purpose       | Command                                                  | Expected on success |
| ------------- | -------------------------------------------------------- | ------------------- |
| Typecheck     | `bun run typecheck`                                      | exit 0              |
| Lint          | `bun run lint`                                           | exit 0              |
| Gateway tests | `bun --bun vitest run apps/gateway/src/Handlers.test.ts` | all pass            |
| Core tests    | `bun --bun vitest run packages/core`                     | all pass            |
| All           | `bun run check`                                          | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/protocol/src/Conversation.ts` (add `ConversationId`, use it for `id`)
- `packages/protocol/src/Run.ts` (use it for `conversationId`)
- `packages/protocol/src/Api.ts` (use it for the five `id` payloads)
- `packages/core/src/ConversationStore.ts` (defence in depth in `layerFile`)
- `apps/gateway/src/Handlers.test.ts` (one test)

**Out of scope** (do NOT touch, even though they look related):

- `apps/cli/**` — the CLI only sends ids it received from the gateway; no change is needed and the wire type stays `string` at the TypeScript level.
- `packages/core/src/Runner.ts` — it generates ids with `crypto.randomUUID()`, which the pattern accepts.
- The memory layer of the store — it has no filesystem and needs no check.

## Git workflow

- Branch: `fix/conversation-id-validation`
- Commit style: conventional commits, e.g. `fix: refuse conversation ids that are not safe path segments`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Define the id schema in the protocol

In `packages/protocol/src/Conversation.ts`, before the `Conversation` class, add:

```ts
/** What may name a conversation on the wire and on disk: one path segment, no dots, no separators. */
export const ConversationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/),
).annotate({ description: "letters, digits, _ and -; a UUID fits" });
export type ConversationId = typeof ConversationId.Type;
```

Change the class field to `id: ConversationId,`.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Use it everywhere an id enters

- `packages/protocol/src/Run.ts:16`: `conversationId: Schema.optional(ConversationId),` (import `ConversationId` from `./Conversation.ts`).
- `packages/protocol/src/Api.ts`: in the payloads of `getConversation`, `transcript`, `rename`, `removeConversation`, and `compact`, replace `id: Schema.String` with `id: ConversationId` (import from `./Conversation.ts`).

**Verify**: `bun run typecheck` → exit 0; `grep -c "id: ConversationId" packages/protocol/src/Api.ts` → `5`

### Step 3: Defend the file store independently

In `packages/core/src/ConversationStore.ts` inside `layerFile`, next to `infoFile`/`historyFile`, add:

```ts
/** The wire schema already refuses these; the store refuses them again because it owns the disk. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safe = (id: string) =>
  SAFE_ID.test(id)
    ? Effect.void
    : Effect.fail(
        new ConversationStoreError({ id, message: `${id} is not a valid conversation id` }),
      );
```

Then make each disk-touching function check first: `get` → `yield* safe(id)` as the first line (its trailing `orElseSucceed` turns the failure into `Option.none()`, which is the intended outcome for reads); `history` likewise if it reads by id; `save` and `update` → `yield* safe(info.id)` first; `remove` → `yield* safe(id)` first. Keep each function's existing `Effect.mapError` wrapper; `safe` already produces the right error type, so the wrapper is a no-op for it. Read the file once before editing to confirm which functions exist (`get`, `history`, `list`, `save`, `update`, `remove`).

**Verify**: `bun run typecheck` → exit 0; `bun --bun vitest run packages/core` → all pass

### Step 4: Test through the RPC layer

In `apps/gateway/src/Handlers.test.ts`, inside the `layer(TestLayer)("gateway api", …)` block, add:

```ts
it.effect("refuses a conversation id that is not a path-safe token", () =>
  Effect.gen(function* () {
    const client = yield* makeClient;
    for (const id of ["../escape", "a/b", "..", "with space", ""]) {
      assert.isTrue(yield* Effect.isFailure(client.getConversation({ id })), id);
      assert.isTrue(
        yield* Effect.isFailure(
          Stream.runDrain(client.run({ agent: "triage", input: "x", conversationId: id })),
        ),
        id,
      );
    }
    const ok = yield* client
      .getConversation({ id: "0f0f0f0f-0000-4000-8000-000000000000" })
      .pipe(Effect.flip);
    assert.strictEqual(ok._tag, "ConversationNotFound");
  }),
);
```

The last assertion proves a well-formed unknown id still reaches the handler (and is refused for the right reason), so the pattern is not over-strict.

**Verify**: `bun --bun vitest run apps/gateway/src/Handlers.test.ts` → all pass, one more test

### Step 5: Full check

**Verify**: `bun run check` → exit 0

## Test plan

- `Handlers.test.ts` (Step 4): five malformed ids are refused on `getConversation` and on `run`; a well-formed unknown id is `ConversationNotFound`.
- Existing tests keep passing: `Runner.test.ts` and `Handlers.test.ts` create conversations with UUIDs.
- Pattern: the existing conversation test in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "export const ConversationId" packages/protocol/src/Conversation.ts` → 1 match
- [ ] `grep -c "id: ConversationId" packages/protocol/src/Api.ts` → `5`
- [ ] `grep -n "Schema.optional(ConversationId)" packages/protocol/src/Run.ts` → 1 match
- [ ] `grep -n "SAFE_ID" packages/core/src/ConversationStore.ts` → at least 2 matches
- [ ] `bun --bun vitest run apps/gateway/src/Handlers.test.ts` passes with the new test
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows only in-scope files (plus the pre-existing uncommitted `packages/mcp` work)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `Schema.isPattern` or `.check` is not accepted at typecheck — look at `node_modules/effect/dist/Schema.d.ts` for the spelling and report it; do not fall back to a hand-rolled parse (CLAUDE.md forbids it).
- `ConversationStoreError` does not have `id` and `message` fields as assumed.
- An existing test fails because it uses an id that the pattern rejects — report which; do not loosen the pattern beyond `[A-Za-z0-9_-]`.
- The `run` RPC in Step 4 does not fail on a bad `conversationId` — the payload spread in `Api.ts` may not include the field; report.

## Maintenance notes

- Any new RPC that takes a conversation id must use `ConversationId`, not `Schema.String`. Reviewers: grep `Api.ts` for `id: Schema.String` in future changes.
- When `@magentic/store` (SQLite) replaces the file store, the pattern is still worth keeping at the wire; the store-level check can go.
- Deferred: the same treatment for `agent` names used in file paths (none today; `agents/*.yaml` names come from the operator).
