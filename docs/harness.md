# Harness design

This document plans the runtime that turns an `AgentDefinition` into a running agent that
people reach from Slack, a terminal, or Cursor. It covers the request pipeline, the domain
model, package boundaries, storage, and delivery phases. Identity is in `identity.md`.

Everything below is built on Effect 4 primitives that exist in the installed rc
(`effect/unstable/ai`, `effect/unstable/httpapi`, `effect/unstable/workflow`,
`effect/unstable/cluster`, `@effect/sql-sqlite-bun`). Where a primitive is "verified in the
checkout, not yet exercised in this repo" it is marked **verify**.

## Vocabulary

| Term         | Meaning                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Principal    | Who is asking. Resolved once at the edge by identity. Carries id, groups, provider, and the surface it came from. |
| Surface      | Where a request enters: `slack`, `cli`, `cursor`, `http`, `cron`. Surfaces are thin adapters.                     |
| Agent        | A named definition: system prompt, model, tool names, skill names, memory scope, default policy hints.            |
| Tool         | An `effect/unstable/ai` `Tool` with a handler layer plus magentic annotations: `capability` and `risk`.           |
| Capability   | A coarse label policy reasons about (`fs:read`, `fs:write`, `shell`, `http:egress`, `github:write`).              |
| Skill        | A directory with `SKILL.md` (Agent Skills format) and optional scripts. Loaded on demand into the prompt.         |
| Run          | One invocation: principal + surface + agent + input. Emits a stream of `RunEvent`s and ends in a `RunResult`.     |
| Conversation | A chain of runs that share chat history. Keyed per surface context (Slack thread, CLI session, Cursor workspace). |
| Approval     | A suspended run waiting for a named approver to decide. Durable across gateway restarts.                          |
| Audit event  | An append-only record of something that happened, always attributed to a principal and a run.                     |

## Request pipeline

Every request, from every surface, goes through the same steps inside the gateway.

```
surface adapter
  → authenticate            Identity.authenticate(credential) → Principal          (identity.md)
  → build AgentRequest      { id, agent, surface, principal, input, conversation }
  → admit                   Policy.admit(request) → Allow | Deny | RequireApproval
  → run                     Runner.run(request)   → Stream<RunEvent>
      → load agent          AgentRegistry.get
      → resolve toolkit     ToolRegistry.forAgent(agent) filtered by Policy.allowedTools(principal, agent)
      → wrap toolkit        every handler: audit → Policy.authorizeToolCall → (maybe suspend) → handler → audit
      → restore chat        ConversationStore.load → Chat.fromJson, or Chat.fromPrompt(system)
      → loop                LanguageModel.generateText / streamText with the wrapped toolkit
      → persist             ConversationStore.save(chat.exportJson), Memory writes
  → deliver                 surface adapter renders RunEvents (SSE, Slack message edits, MCP progress)
  → audit                   run.started, policy.decision, tool.called, approval.*, model.called, run.finished
```

Policy is enforced twice: once at admission (may this principal talk to this agent at all)
and once per tool call (may this principal use this capability with these arguments). The
per-call hook is what makes "what they may use" real; admission alone is not enough.

## Domain model (`@magentic/protocol`)

Schemas are `Schema.Class` and live in protocol so surfaces and the CLI share them.

- `Principal` (exists). Add `surface`, `sessionId`, and `onBehalfOf` (for cron and service
  principals acting for a person).
- `AgentInfo` (exists, with `model`). Add `skills`, `capabilities`.
- `AgentRequest` (exists). Add `conversationId`.
- `RunId`, `ConversationId`, `ApprovalId`: branded strings.
- `RunEvent` tagged union: `RunStarted`, `TextDelta`, `ToolCallRequested`, `ToolCallApproved`,
  `ToolCallDenied`, `ToolCallResult`, `ApprovalRequested`, `RunFinished`, `RunFailed`.
- `RunResult`: final text, token usage, tool call count, audit ids.
- `Approval`: id, runId, principal, tool, capability, argument summary, approvers, status,
  decidedBy, decidedAt.
- `Decision` moves from `@magentic/policy` into protocol because the CLI shows it.

HttpApi groups (all under `Api`):

| Group           | Endpoints                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`        | `GET /health`, `GET /me`                                                                                                                       |
| `agents`        | `GET /agents`, `GET /agents/:name`, `POST /agents/:name/runs` (returns `RunId`)                                                                |
| `conversations` | `GET /conversations?agent=`, `GET /conversations/:id`, `GET /conversations/:id/transcript`, `DELETE /conversations/:id`; the caller's own only |
| `runs`          | `GET /runs/:id`, `GET /runs/:id/events` (SSE), `POST /runs/:id/cancel`                                                                         |
| `approvals`     | `GET /approvals` (pending for me), `POST /approvals/:id/decide`                                                                                |
| `sessions`      | `POST /sessions/login`, `POST /sessions/logout`, `GET /tokens`, `POST /tokens`, `DELETE /tokens/:id`                                           |
| `slack`         | `POST /slack/events`, `POST /slack/interactions` (signed, not bearer)                                                                          |
| `mcp`           | `POST /mcp` (Streamable HTTP, bearer)                                                                                                          |

All groups except `system.health`, `sessions.login`, and `slack` sit behind the
`Authentication` middleware (see identity.md).

## Core services (`@magentic/core`)

Each is a `Context.Service` with static layers. Ids are `magentic/core/<Name>`.

- **AgentRegistry** (exists). Gains `layerFromConfig` that takes agent definitions from the
  `ConfigDirectory` service (see "Configuration" below) and swaps them on reload.
- **ToolRegistry**: fed by plugins (see `plugins.md`); `forAgent(def)` returns a
  `Toolkit.WithHandler` whose `handle` runs policy, hooks, the tool, and audit. Built-in
  tools ship in `@magentic/tools` as plugins: `read_file`, `write_file`, `edit_file`,
  `list_dir`, `glob`, `grep`, `shell`, `http_fetch`, `load_skill`, `remember`, `recall`. The
  file tools stay inside the `WorkspaceRoot`; `glob` and `grep` walk the tree themselves,
  skipping `node_modules`, `.git`, and hidden directories, so nothing depends on ripgrep. Each declares `capability` and `risk` through
  `Tool.make(...).annotate(...)`.
- **SkillRegistry**: scans `skills/**/SKILL.md`, parses frontmatter, exposes `list` and
  `load(name)`. Summaries are injected into the system prompt; the body is loaded via the
  `load_skill` tool so context stays small.
- **Memory**: `remember(scope, key, text)`, `recall(scope, query)`. Scopes: `agent` (shared by
  the team), `principal` (private to one person), `conversation`. Storage is `KeyValueStore`
  first, SQL with full-text search second, embeddings (`EmbeddingModel`) third.
- **ConversationStore**: `get(id)`, `history(id)`, `list`, `save(info, chatJson)`, `remove(id)`.
  History is `Chat.exportJson` output, opaque to us, so it survives model provider changes;
  beside it sits a `Conversation` record (agent, principal, title from the first input, the
  model of the latest run, the directory the surface started it from, timestamps, message
  count, usage) that the runner rewrites after
  every run, failed ones included. `layerFile(dir)` keeps one directory per conversation
  under the gateway's data directory (`conversation.json`, `history.json`); `layerMemory`
  is for tests. This is the opencode session model without the generated title.
- **Runner**: the loop above. `run(request): Stream<RunEvent, RunError>`. Owns the tool
  wrapping. Depends on `LanguageModel`, `Policy`, `Audit`, `ApprovalService`.
  `compact(conversation)` folds the context into a summary on request; the loop does the
  same on its own after a model call whose usage reaches the window less a reserve
  (`Compaction.ts`, after opencode: 20k tokens or the model's output limit, whichever is
  smaller), keeping up to a quarter of the room in recent turns word for word and emitting
  `CompactionStarted` and `Compacted`. A model call that fails before anything reached the
  surface is tried again when Effect's client marks the error retryable (transport errors,
  rate limits, provider 5xx): up to five times, backing off from two seconds and doubling
  with jitter, capped at thirty seconds unless the provider sent `retry-after`
  (`Retry.ts`, after opencode). The chat appends the prompt even when the stream fails, so
  the history is put back before each try; each try emits `Retrying` with the wait. A call
  that fails after it spoke is not retried, so nothing shows twice.
  The summary is a user message marked in its
  `options.magentic`; the model sees the system prompt, the latest summary, and what
  follows it, while `history.json` keeps everything before as well, so transcripts still
  show it. `POST /conversations/:id/compact` is the manual route. Compaction is core, not a
  plugin: a plugin command runs in the surface and only reaches the gateway through the
  protocol, so it cannot read the history or call the model.
- **ModelProvider** (`@magentic/model`): picks the `LanguageModel` layer from
  `magentic.yaml`. Decision: Effect AI (`effect/unstable/ai`) is the model interface, not the
  Vercel AI SDK. The runner, `Toolkit`, `Chat`, `McpServer`, and the policy wrapper all sit
  on Effect's loop, and a provider is only two functions handed to `LanguageModel.make`.
  Three tiers of providers:
  1. Effect's own packages at our exact rc: OpenAI (first, as the Codex subscription
     provider), Anthropic, OpenAI-compatible, OpenRouter. Zero adapter work. The Codex
     provider (`Codex.layer` in `@magentic/model`) is Effect's OpenAI Responses client
     pointed at `chatgpt.com/backend-api/codex` with a ChatGPT login instead of an API key:
     device-code sign-in via `magentic auth login` (provider picker, or `--provider openai-codex --method chatgpt`), or the `import` method to copy an
     existing Codex CLI login; tokens refresh five minutes before expiry and once more on a
     401; non-streaming calls are turned into streams and reassembled because the backend
     accepts only `stream: true`. Details in `research/openai-codex-subscription.md`.
  2. `layerAiSdk`: one bridge from the AI SDK provider interface (`@ai-sdk/provider`
     `doStream` / `doGenerate`, which does not depend on the `ai` core) to
     `LanguageModel.make`. One module unlocks Bedrock, Vertex, Gemini, and the rest of the
     `@ai-sdk/*` packages while Effect keeps the loop. Needs `zod` as a peer. Phase 2.
  3. Hand-written protocol clients, as opencode's private `@opencode-ai/llm` does. Only if we
     ever want to drop the AI SDK dependency. Not planned.
     A `layerFake` built the same way backs runner tests.
- **ApprovalService**: `request(run, toolCall, approvers)` suspends the run;
  `decide(id, principal, verdict)` resumes it. Implementation is a `Workflow` with a
  `DurableDeferred` per approval so the wait survives restarts (**verify**:
  `WorkflowEngine.layerMemory` for tests, `ClusterWorkflowEngine` + `SingleRunner` + SQL
  storage for durable single-box deployment).
- **CronScheduler**: reads `crons` from config: `{ name, cron, agent, input, onBehalfOf,
deliverTo }`. Phase one uses `Schedule.cron` in-process. Durable version uses
  `ClusterCron.make` on the same single-runner cluster as approvals.

`@magentic/policy`, `@magentic/identity`, `@magentic/audit` stay separate packages so their
tests are isolated and the gateway is the only place they meet.

## Policy (`@magentic/policy`)

```ts
interface Policy {
  admit(request: AgentRequest): Effect<Decision>;
  allowedTools(principal: Principal, agent: AgentDefinition): Effect<ReadonlySet<string>>;
  authorizeToolCall(ctx: { principal; agent; tool; capability; args }): Effect<Decision>;
}
```

Rules live in `policy.yaml` in the config directory and are decoded through a `Schema.Class`
at load time. They are declarative on purpose: a reviewer can read them in a PR and an
operator can edit them over SSH without a toolchain.

```yaml
defaults:
  admit: allow
  capabilities:
    fs:write: approval
    shell: approval

agents:
  deploy-bot:
    admit: [group:sre]
    capabilities:
      shell: { approval: { approvers: [group:sre-leads] } }

principals:
  okta:alice:
    capabilities:
      shell: allow
```

Matching is by `group:<name>`, `principal:<id>`, `provider:<name>`, and `surface:<name>`.
The most specific match wins: principal over agent over defaults. A capability value is
`allow`, `deny`, or `approval` with optional `approvers`.

The `Policy` service keeps the decoded rules in a `SubscriptionRef`. Every `admit` and
`authorizeToolCall` reads the current value when it runs, so a reload takes effect on the
next tool call, including inside runs that are already in progress. Two consequences are
deliberate:

- A run admitted before a reload keeps running; only its tool calls see the new rules.
- A pending approval is re-authorized against current rules when the approver decides, so a
  capability removed while the approval sat in Slack cannot slip through.

There is no code escape hatch in the config. Teams that need custom logic get a policy
webhook later: the gateway posts the decision context and accepts a `Decision` back.
`layerAllowAll` stays for tests and for local single-user mode.

## Audit (`@magentic/audit`)

`AuditEvent` grows to `{ id, at, runId?, principalId, sessionId?, surface, action, detail }`.
Actions are a `Schema.Literals` union, not free strings. Sinks: memory (tests), SQLite
(default), JSON lines to stdout (containers). Tool arguments are stored as a redacted summary
plus a hash; full arguments never hit the audit log by default.

## Storage (`@magentic/store`)

One SQLite file on the box via `@effect/sql-sqlite-bun`. `@magentic/store` owns the
`SqlClient` layer and migrations; each package contributes its own migration file and a
`layerSql` variant of its service. Tables: `users`, `identities`, `sessions`, `tokens`,
`conversations`, `memory`, `audit`, `approvals`, plus the cluster message tables when the
durable engine is enabled. Postgres is a later config option, not a separate code path,
because `SqlClient` abstracts the dialect for what we need.

## Surfaces

- **CLI** (`apps/cli`): `magentic [agent]` opens the full-screen chat (exists); `-c` picks up
  the newest conversation and `-r <id>` a named one, transcript and model restored, and
  `/resume` and `/new` do the same from inside the chat, as in opencode. `magentic run
"<input>"` prints the events as plain lines (exists), `magentic agents` (exists), `magentic
auth login|list|logout` (exists, inline `@clack/prompts` like opencode's, not the TUI),
  `magentic approvals` (list and decide), `magentic tokens`, `magentic config check`,
  `magentic reload`. Talks only `@magentic/protocol` through `HttpApiClient`, with one
  exception: when nothing answers at a local gateway URL the CLI builds the gateway layer in
  its own process for the session, so a laptop needs no separate `bun run dev`. The chat is
  OpenTUI with the Solid renderer (see `research/opentui-solid.md`): Effect parses arguments
  and owns the renderer lifecycle, OpenTUI's own signal and console handling is disabled, and
  the embedded gateway runs with request logging off so nothing prints over the screen.
  The header is one row beside the mark (`tui/Logo.tsx`, dot `#d95f21`): the name on the
  left, the working directory and the CLI version (`Version.ts`, read from the package)
  on the right.
  Assistant text is drawn with OpenTUI's `<markdown>` element, streaming while the run is
  in flight; the syntax style (`tui/Markdown.ts`) follows the light or dark palette.
  Pasting follows opencode (`tui/Paste.ts`): a paste over 150 characters or three lines
  folds into `[Pasted text #1 +N lines]` and unfolds when sent; a placeholder pasted back
  unfolds first, so it never nests. An image on the clipboard (`ctrl+v`, or the empty paste
  some terminals send for one) or the pasted path of an image file becomes `[Image #1]` and
  goes along as a `RunRequest.attachments` entry, base64 on the wire. The runner hands the
  model bytes, since Effect's provider clients base64-encode a byte array but encode a
  string a second time, and stores them as base64 in `history.json`, which cannot hold bytes.
  `/compact` (in the conversation commands plugin, over `ChatSession.compact`) asks the
  gateway to fold the conversation into a summary; the transcript keeps every earlier line
  and shows the summary where the compaction happened, on resume too. `/rename <title>`
  (same plugin, over `ChatSession.rename` and `PATCH /conversations/:id`) names the
  conversation, as in opencode; until then the title is the first input, and a bare
  `/rename` says what it is.
- **Slack** (`packages/surface-slack`): Events API subscription for mentions and DMs;
  interactivity endpoint for approval buttons. Signature verification is the auth. Thread id
  becomes the conversation id. Replies are posted then edited as text streams in.
- **Cursor** (`packages/surface-cursor`): an MCP server via `McpServer.layerHttp` mounted at
  `/mcp`. Each agent is exposed as an MCP tool `ask_<agent>`; skills are exposed as MCP
  prompts. Bearer token auth is applied by the surrounding router (the MCP layer does not do
  auth itself, per its docs).
- **HTTP**: the raw API, used by CI and by the other surfaces.

## Configuration

Everything an operator edits is plain YAML in one directory. Default `./magentic` locally and
`/etc/magentic` on a server, overridable with `MAGENTIC_HOME`. Bun parses YAML natively, so
there is no extra dependency, and the whole directory can be committed to a team repo and
deployed by copying it over.

```
magentic/
  magentic.yaml        gateway: model provider, store path, identity, sync, reload mode
  agents/
    deploy-bot.yaml    one agent per file
  policy.yaml
  crons.yaml
  groups.yaml          local group overrides merged with provider groups
  skills/
    release-notes/SKILL.md
  prompts/             optional, referenced from agents by path
```

An agent file:

```yaml
name: deploy-bot
description: Ships services to staging and production.
model: anthropic/claude-sonnet-5 # provider, or provider/model; see plugins.md
prompt:
  file: prompts/deploy-bot.md # or an inline string
tools: [shell, read_file, http_fetch]
skills: [release-notes]
memory: agent # agent | principal | none
```

Secrets never go in these files. API keys, signing secrets, and tokens come from environment
variables or a `.env` beside the directory, read through `Config.Redacted`.

**Loading.** A `ConfigDirectory` service in `@magentic/core` reads the directory, decodes
every file through the same `Schema.Class` models the runtime uses, and exposes the result
as a `SubscriptionRef<LoadedConfig>`. A typo fails with the file path and field, never at
run time. `magentic config check` validates a directory without starting a gateway.

**Reload.** Three triggers, one swap:

- `magentic reload`, an admin-only authenticated endpoint the CLI calls.
- `SIGHUP` to the gateway process, for people editing over SSH.
- A debounced watcher on the directory, opt-in with `reload: watch` in `magentic.yaml`.

A reload re-decodes the whole directory and swaps `LoadedConfig` atomically. Registries
(agents, policy, crons, skills, groups) subscribe to it. If any file fails to decode, the
previous config stays in force, the error is logged with path and field, and an audit event
records the failed attempt. A bad edit cannot take the gateway down or leave it without
policy. Every successful reload writes an audit event with who triggered it and a content
hash, so "which rules were in force when this call was approved" has an answer.

## Gateway wiring (`apps/gateway`)

`Server.ts` composes: `Config` from environment → `ConfigDirectory` → store → identity →
policy → audit → model provider → core services → handlers → Slack + MCP routes →
`HttpRouter.serve`. Nothing outside the gateway imports identity, policy, or audit layers.

## Phases

1. **Runner end to end, in memory.** `ConfigDirectory` with `agents/` and `policy.yaml`,
   ModelProvider (Anthropic), ToolRegistry with `read_file` and `shell`, Runner with
   policy-wrapped toolkit, `POST /agents/:name/runs` plus SSE, CLI `run` and `config check`.
   Local identity, memory audit. This is the "locally
   it's just a good agent" milestone.
   Done so far: `Runner` (tool loop over `Chat`, per-agent toolkit subset, in-memory
   `ConversationStore`), `POST /agents/:name/runs` as `HttpApiSchema.StreamSse` of
   `RunEvent`, `layerAuto` model selection (ChatGPT login, then OpenAI key, then Anthropic
   key), the built-in `assistant` agent with `read_file` and `write_file`, admission through
   `Policy` and a `run.started` audit event, and the CLI chat and `run`. Then the plugin
   system from `plugins.md`: every tool, provider, and agent comes from a plugin hosted by
   `PluginHost`, `magentic.yaml` disables plugins and tools or adds external ones, and every
   tool call passes through `Policy.evaluateToolCall` and audit. Agents load from
   `agents/*.yaml` through `configAgentsPlugin`, with `model:` per agent and reload on SIGHUP
   or `reload: watch`. Still open: `policy.yaml`, `shell`, `config check`, the reload
   endpoint.
2. **Persistence and reload.** `@magentic/store`, ConversationStore, Memory, audit sink,
   SkillRegistry, `magentic reload` plus `SIGHUP` plus the watcher.
3. **Slack + approvals.** Slack surface, Slack identity provider, ApprovalService with the
   durable workflow engine, approval buttons in Slack and `magentic approvals` in the CLI.
4. **Cursor + tokens + OIDC.** MCP route, personal access tokens, Okta login for the CLI.
5. **Cron.** In-process first, then `ClusterCron` once the durable engine from phase 3 is in.

Each phase ships with `bun run check` green and tests written with `@effect/vitest` beside
the code.
