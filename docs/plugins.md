# Plugins

Everything that contributes tools, model providers, agents, or observers to magentic is a
plugin, including the pieces we ship. There is one contract, one loader, and one order. A
team disables a built-in the same way it adds its own. This mirrors opencode's v2 plugin
design (`packages/plugin/src/v2/effect` in the reference checkout), adapted to our Effect
layering and to the fact that policy and audit are not optional here.

## What opencode does, and what we take

opencode v1 is a function `(input, options) => Promise<Hooks>` returning one object with
optional slots (`tool`, `auth`, `provider`, `tool.execute.before`, `permission.ask`, ...).
Built-in plugins (Codex auth, Copilot, Azure, xAI) are literally that same function, listed in
`internalPlugins()` and imported statically; external ones come from `plugin: [...]` in
config, resolved from npm on demand or from file URLs. A `ToolRegistry` concatenates built-in
tools with plugin tools and filters them per agent through the permission ruleset.
`tools: { name: false }` in config, globally or per agent, hides a tool.

opencode v2 (`PLAN.md`, partly implemented) replaces the returned hooks object with imperative,
scope-owned registration: `define({ id, effect: (ctx) => Effect })`, where setup calls
`ctx.<domain>.transform(cb)` for replayable state (agents, catalog, commands, skills) and
`ctx.<domain>.hook(name, cb)` for runtime interception. Registrations die with the plugin's
scope, order is plugin order then registration order, a domain rebuilds when its transforms
change, boot batches rebuilds, and internal and external plugins share the public API without
importing core.

We take v2 wholesale: `define`, scoped registrations, transform versus hook, domain rebuilds,
same API for built-ins. We drop: zod tool arguments (Effect `Schema` is the only schema
here), the promise wrapper, on-demand npm installs into a global cache, and auto-discovered
loose `tools/*.ts` files. TUI plugins are narrowed to slash commands that describe a picker
rather than draw one (see Commands).

## Contract (`@magentic/plugin`)

A new package, tiny, depending only on `effect` and `@magentic/protocol`. Plugin authors,
including our own packages, import this and nothing from `@magentic/core`.

```ts
export interface Plugin<R = never> {
  readonly id: string; // "file-tools", "openai-codex", "acme-linear"
  readonly description: string;
  readonly setup: (ctx: PluginContext) => Effect.Effect<void, PluginSetupError, Scope.Scope | R>;
}
export const define = <R = never>(plugin: Plugin<R>): Plugin<R> => plugin;

export interface Registration {
  readonly dispose: Effect.Effect<void>;
}

/** Services the gateway guarantees to every plugin's setup, so `R` can stay `never` for external ones. */
export type PluginServices = FileSystem.FileSystem | Path.Path | HttpClient.HttpClient;
```

`PluginContext` has one domain per kind of contribution. Each domain uses one of two shapes:

- **register / transform** for state the rest of the system reads (tools, providers, agents).
  Scope-owned, ordered, replayable, and the domain rebuilds when a registration is added or
  removed.
- **hook** for interception at a live boundary (before and after a tool call, before a model
  call). Sequential in plugin order; later hooks see earlier mutations.

```ts
export interface PluginContext {
  /** Decoded by the plugin with its own Schema; `{}` when the config has none. */
  readonly options: Schema.Json;
  readonly paths: { readonly config: string; readonly workspace: string; readonly data: string };
  readonly tool: ToolDomain;
  readonly model: ModelDomain;
  readonly agent: AgentDomain;
  readonly command: CommandDomain;
  readonly event: EventDomain;
  readonly bridge: BridgeDomain;
  readonly http: HttpDomain;
}
```

### Tools

```ts
export interface ToolDomain {
  register<T extends Tool.Any>(
    tool: T,
    handle: Tool.Handler<T>,
  ): Effect.Effect<Registration, never, Scope.Scope | Tool.HandlerServices<T>>;
  hook(
    name: "execute.before",
    cb: (event: ToolCallBefore) => Effect.Effect<void>,
  ): Effect.Effect<Registration, never, Scope.Scope>;
  hook(
    name: "execute.after",
    cb: (event: ToolCallAfter) => Effect.Effect<void>,
  ): Effect.Effect<Registration, never, Scope.Scope>;
}
```

`register` captures the handler's services at registration time with `Effect.context` and
provides them back at call time, so a tool built in the plugin's scope keeps its `WorkspaceRoot`,
`FileSystem`, or HTTP client without the registry knowing what they are. A plugin that already
has a `Toolkit` does `const handlers = yield* FileToolsLayer` style building inside its scope
and registers each tool from `handlers.tools` with `handlers.handle` bound to the name; a
`registerToolkit(withHandler)` helper wraps that.

Rules the registry enforces at registration, failing the plugin's setup with a
`PluginSetupError` that names the tool:

- The tool declares a `Capability` from `@magentic/protocol`. The current default of `"none"`
  goes away; policy cannot reason about a tool it cannot classify.
- The name is unique across plugins. No shadowing of a built-in by an external plugin; disable
  the built-in instead.

Every call runs with a `ToolCallContext` service in scope (`runId`, `agent`, `principal`,
`callId`). Tools that need it ask for it; the registry provides it per call. Interruption is
Effect interruption, so there is no abort signal to thread through.

Hook events are purpose-built objects, never the registry's internals:

```ts
interface ToolCallBefore {
  readonly tool: string;
  readonly call: ToolCallContext;
  params: Schema.Json; // reassignable: a hook may rewrite
  deny(reason: string): void; // stops the call; the model sees a failure result
}
interface ToolCallAfter {
  readonly tool: string;
  readonly call: ToolCallContext;
  readonly params: Schema.Json;
  result: Schema.Json; // reassignable
  readonly isFailure: boolean;
}
```

### Model providers

One registration covers what today is split between `apps/cli/src/auth/Providers.ts` (login
methods, status, logout) and `packages/model/src/ModelProvider.ts` (which `LanguageModel` layer
to build). They belong together: a provider is how you sign in and what you get once you have.

```ts
export interface ModelProviderRegistration {
  readonly id: string; // "openai-codex", "openai", "anthropic", "zai", "opencode-zen"
  readonly name: string;
  readonly description: string;
  readonly methods: ReadonlyArray<LoginMethod>; // the existing LoginMethod, moved here
  readonly status: Effect.Effect<Option.Option<string>, LoginError>;
  readonly logout: Effect.Effect<void, LoginError>;
  /** The models this provider can serve, in picker order. */
  readonly models: Effect.Effect<ReadonlyArray<ModelInfo>>;
  /** Used when an agent names the provider alone. */
  readonly defaultModel: string;
  /** The layer for one of `models`; None when not signed in. Built once per gateway. */
  model(
    id: string,
  ): Effect.Effect<
    Option.Option<Layer.Layer<LanguageModel.LanguageModel, ModelProviderError>>,
    LoginError
  >;
  /** The request configuration that makes a model think at one of its `reasoningLevels`. */
  reasoning?(model: string, level: string): Effect.Effect<Option.Option<Context.Context<never>>>;
}
export interface ModelDomain {
  register(provider: ModelProviderRegistration): Effect.Effect<Registration, never, Scope.Scope>;
  /** Every provider registered so far, in plugin order. */
  readonly providers: Effect.Effect<ReadonlyArray<ModelProviderRegistration>>;
}
```

`ModelInfo` carries what the catalog says of each model beyond its limits: `reasoningLevels`,
the names its thinking can be set to (the effort names when it takes an effort, `high` and
`max` budgets when it takes a budget, none when it only turns on and off), and `cost`, its
prices per million tokens. A chat cycles the levels with `ctrl+t` and sends the choice with
each run; the runner asks the provider's `reasoning` for the request configuration and
provides it as context around the model call, so a provider that speaks the OpenAI protocol
answers with a reasoning effort and one that speaks Anthropic's with an effort or a thinking
budget. The runner prices every call from `cost` and reports it on the `TokenUsage` event and
the conversation's usage; a provider whose plan is not metered by the token, such as a ChatGPT
subscription, leaves `cost` out.

This follows opencode: an agent's `model:` is a `provider/model` reference such as
`opencode-zen/gpt-5.5`; a bare provider id takes that provider's default model, and no
reference at all takes the first signed-in provider in plugin order. `ModelRegistry` parses
the reference, checks the model against the provider's list (the error names the known ids),
and builds each `provider/model` once.

Where the model list comes from is also opencode's answer: models.dev. `ModelCatalog` in
`@magentic/plugin` is one of the services every plugin receives. It ships a bundled
snapshot (`packages/plugin/src/catalog/snapshot.json`, refreshed with `bun run catalog:sync`)
and, unless `MAGENTIC_MODELS_OFFLINE` is set, fetches `MAGENTIC_MODELS_URL` (models.dev)
into `~/.cache/magentic/models.json` once an hour. Each catalog entry says which protocol a
model speaks (`provider.npm`, an AI SDK package name) and where; the shipped plugins turn
that into a route to one of Effect's clients. That is how OpenCode Zen serves Claude through
Anthropic Messages and GPT through OpenAI Responses from one key, and why models needing a
client Effect does not ship (Gemini, chat-completions-only vendors) are not listed.

### Agents

```ts
export interface AgentDraft {
  list(): ReadonlyArray<AgentDefinition>;
  get(name: string): Option.Option<AgentDefinition>;
  set(agent: AgentDefinition): void;
  update(name: string, f: (agent: AgentDefinition) => AgentDefinition): void;
  remove(name: string): void;
}
export interface AgentDomain {
  transform(
    cb: (draft: AgentDraft) => Effect.Effect<void>,
  ): Effect.Effect<Registration, never, Scope.Scope>;
  readonly rebuild: Effect.Effect<void>;
}
```

The built-in `assistant` agent is one transform in the gateway's `assistant` plugin. The
`ConfigDirectory` of `harness.md` is a plugin too, `config-agents` (`configAgentsPlugin` in the
gateway): its transform decodes `agents/*.yaml` into the draft, and its file watcher calls
`ctx.agent.rebuild`. That is the "registries subscribe to LoadedConfig"
mechanism from the harness doc, now with one implementation for every rebuildable domain
instead of one per registry. `AgentRegistry` keeps its interface and reads the committed state.

### Commands

A slash command in a chat, `/name args`, is a plugin contribution too. The command never
draws anything: it describes a picker (sections of rows, a detail column, action keys such as
`f`, bound with ctrl by the surface since a bare letter types into the filter) and loops on
the answer, the way a login method reports through `LoginUi`. Any surface that can show a
list can host one. Typing filters the rows by label and detail, every word typed matching
somewhere; a picker may also carry `unlisted` rows that only a filter finds, the level below
flattened so typing at the top reaches it.

```ts
export interface CommandRegistration {
  readonly name: string; // without the slash, unique across plugins
  readonly description: string;
  run(input: {
    ui: CommandUi;
    session: ChatSession;
    args: string;
  }): Effect.Effect<void, CommandError>;
}
export interface CommandUi {
  pick(picker: Picker): Effect.Effect<Option.Option<Picked>>; // none when the person backs out
  notify(message: string): Effect.Effect<void>;
}
export interface ChatSession {
  readonly agent: string;
  readonly model: Effect.Effect<Option.Option<string>>;
  setModel(ref: string): Effect.Effect<void>;
  readonly usage: Effect.Effect<Option.Option<SessionUsage>>; // latest call and running totals
  readonly conversation: Effect.Effect<Option.Option<Conversation>>; // what the next input continues
  readonly conversations: Effect.Effect<ReadonlyArray<Conversation>, CommandError>; // this agent's, newest first
  resume(id: string): Effect.Effect<void, CommandError>; // restore the transcript and continue from it
  readonly startNew: Effect.Effect<void>;
  readonly mcpServers: Effect.Effect<ReadonlyArray<McpServerInfo>, CommandError>; // the gateway's, connected or not
}
```

Commands run where the surface is. The CLI hosts them in the same local `PluginHost` that
`auth login` uses, beside the provider plugins, so a command can read `ctx.model.providers`
without a gateway. What a command changes about the session travels with the next request:
`setModel` makes the CLI send `model` in every `RunRequest`, and the runner takes that over the
agent's own `model:` for that run. Against a remote gateway the providers a command sees are
the ones signed in on the CLI's machine, the same limit `auth login` has today.

`/model` is the first: favourites (kept in `favourites.json` under `paths.data`) at the top
with the provider at the right, the signed-in providers below (one nobody signed in to has
nothing to offer, so it is not listed), a provider's models on selection, every model as an
unlisted row so typing at the top finds one across providers, `ctrl+f` to favourite or
unfavourite, and `/model provider/model` to set it outright. The CLI remembers the choice
in `chat.json` under its data directory and starts the next chat on it while the machine can
still run it; a resumed conversation's model does not overwrite it. `/context` reads
`session.usage`, folded by the surface from the runner's `TokenUsage` events, and prints
what the latest model call held (input with the cache split, output with the reasoning
split, the share of the model's window), where the runner estimates the context goes
(system prompt, tool definitions, history by author, at four characters a token, since
providers report one total) and the running totals.

`/resume` and `/new` live in the CLI (`apps/cli/src/commands/Conversations.ts`) because they
only make sense where a transcript is drawn. The gateway keeps every conversation under its
data directory (see `harness.md`, ConversationStore) with a title from the first input, the
model of the latest run, the directory it started in, and the usage so far; `/resume` lists
the agent's own for the caller from the current directory (sent with every request, as
opencode sends its project directory; a conversation recorded without one is only listed
unfiltered), newest first with age and size at the right, and choosing one replaces the transcript, the
model, and what `/context` reports with that conversation's. `/resume <id>` names one
outright; `magentic -c` and `magentic -r <id>` do the same at start. `/new` clears the
transcript so the next input starts a conversation; the old one stays listed.

### Events

```ts
export interface EventDomain {
  subscribe<Tag extends RunEvent["_tag"]>(
    tag: Tag,
  ): Stream.Stream<Extract<RunEvent, { _tag: Tag }>>;
}
```

Enough for observers (a metrics plugin, a "post the final answer to a channel" plugin).
Audit events are not exposed to plugins; audit is the gateway's record, not an extension
point.

### Bridges

A bridge is a plugin that brings input in rather than tools out: a mention on a GitHub issue,
a Slack thread, a Linear ticket. It is the first kind of plugin that starts runs, and it
must not get a raw runner: the gateway is the only place identity, policy, and audit are
wired, and a plugin that could pass any `Principal` would be a way around all three. So the
plugin identifies the person and the host mints the principal.

```ts
export interface BridgeDomain {
  /** One per plugin. The surface name is what `surface:<name>` policy rules match. */
  register(bridge: {
    readonly surface: string; // "github", "gitlab", "acme-linear"; unique across plugins
    readonly provider: string; // identity provider name for the people it identifies
    readonly capabilities: { reactions; edit; status; threads; delivery: "push" | "poll" };
  }): Effect.Effect<BridgeHandle, PluginSetupError, Scope.Scope>;
}
export interface BridgeHandle {
  run(input: {
    agent: string;
    conversationId: ConversationId; // the bridge's own key for the thread
    input: string;
    attachments?: ReadonlyArray<Attachment>;
    onBehalfOf: { id: string; displayName: string; groups: ReadonlyArray<string> };
    directory?: string;
  }): Stream.Stream<RunEvent, AgentNotFound | RunDenied>;
  /** A second message while a run is live; false when none is, so the bridge starts one. */
  steer(conversationId, input, onBehalfOf): Effect.Effect<boolean, AgentNotFound | RunDenied>;
  notice(conversationId, text): Effect.Effect<void>;
}
```

What the host does with a `run`: the principal's subject is the machine principal
`system:bridge/<surface>`, its `onBehalfOf` is the person as `<provider>:<id>`, its groups
are the plugin's prefixed with the surface (`github:write`), and its `surface` is the
registered name. `Policy.evaluate` admits or denies the run as it would one from the CLI,
audit records `run.started` or `run.denied` with the surface and the person, and the
runner runs. The conversation belongs to the subject, so every mention on one thread shares
it while "the caller's own conversations" stays true for people. `steer` admits the second
person the same way before offering their message to the run in flight.

The host trusts a bridge's word on who spoke and what they may do, the same trust it
extends to a tool handler: a plugin is operator-installed code. Surface and provider names
are open (`/^[a-z][a-z0-9-]{1,31}$/`, unique across plugins) rather than a closed literal
set, since a custom bridge has to be able to name itself and policy matches by string.

Helpers every bridge wants live beside the domain in `@magentic/plugin`, and none of them
mentions a pull request: the word-bounded mention test (`triggered`, so `@magentic-bot` and
`me@magentic.run` do not fire), the hidden-markup sanitiser (`stripHiddenMarkup`: HTML
comments, invisible characters, image alt text), the permission ladder (`permissionAtLeast`
over `admin`, `write`, `read`, `none`), the context renderer that frames third-party text as
quoted (`renderContext`), the throttled progress editor (`trackProgress`) that turns a
run's events into edits of one message at most every ten seconds, and the answer delivery
(`deliverAnswer`) that disposes of that message once the run has an answer. Where the answer
goes is one decision on every bridge and a different sequence of calls on each, so the
sequence lives in the helper and the bridge only says which `AnswerDelivery` it wants:
`edit` replaces the progress message with the answer, `collapse` folds it into a record of
the run and posts the answer as a new message, `delete` takes it back first, `keep` leaves
it. `deliveryFor` reads the default off the bridge's own `capabilities`: a surface whose
edits reach the people it already notified (`editNotifies`) replaces, and one that freezes a
notification at creation — GitHub mails a comment once and never again — collapses, or the
answer would be read only by whoever opens the thread. A failed run keeps its progress
message expanded wherever the answer is a message of its own: the tools it lists are the
only trace of how far the run got.

### HTTP routes

```ts
export interface HttpDomain {
  /** Mounted under `/plugins/<id>/`; the plugin verifies its own signature on the raw body. */
  route(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string, // relative, no leading slash: "webhook"
    handler: (request: HttpServerRequest) => Effect.Effect<HttpServerResponse, never, R>,
  ): Effect.Effect<Registration, PluginSetupError, Scope.Scope | R>;
}
```

The gateway mounts one route, `/plugins/:plugin/*`, and dispatches to the host's route
registry at request time, so a plugin that failed to set up serves nothing, the prefix keeps
a plugin from claiming `/rpc` or another plugin's path, and the gateway stays the one
listener. A handler has no error channel: it answers with a response for every outcome.
Only a bridge that receives HTTP needs this; a poller is a loop in the plugin's scope and a
socket is outbound.

## Host (`@magentic/core`)

`PluginHost` loads plugins and owns every registry. Layering:

```
PluginHost.layer({ builtin, external, disabled })
  ├─ tool registry   ─▶ ToolRegistry.forAgent(agent): Toolkit.WithHandler  (used by Runner)
  ├─ model registry  ─▶ ModelProvider.layerAuto                            (used by Runner)
  ├─ agent domain    ─▶ AgentRegistry                                      (used by handlers, CLI)
  └─ event bus       ◀─ Runner publishes RunEvents
```

Mechanics, all of which exist in Effect already:

- Each plugin's `setup` runs in a child scope forked from the host scope. A registration is a
  `Ref` update plus `Effect.addFinalizer` that removes it, so closing the child scope removes
  everything the plugin contributed. `Registration.dispose` closes early and is idempotent.
- One generic `Registry<A>` (ordered entries tagged with plugin id and sequence number,
  `snapshot`, `register`) backs every domain. Rebuildable domains add a `SubscriptionRef<State>`
  and a `Semaphore` so rebuilds serialise and coalesce, per opencode's v2 semantics.
- Boot is a batch: all plugins set up sequentially, affected domains rebuilt once at the end.
  Outside boot, a registration change rebuilds its domain immediately.
- Order is built-ins in the order the gateway lists them, then external plugins in config
  order. Hooks and transforms run in that order.
- A plugin whose setup fails is skipped: its child scope closes, the error is logged with the
  plugin id and source, an audit event `plugin.failed` is recorded, and the gateway keeps
  serving. `magentic plugin list` shows it as failed. A built-in failing is the same path;
  there is no privileged code.

`Runner.layer(toolkit)` loses its generic and depends on `ToolRegistry` instead. Per-tool-call
policy lands in `ToolRegistry.forAgent`: the returned `handle` runs `Policy.evaluate` for the
call, then the `execute.before` hooks, then the handler with `ToolCallContext`, then
`execute.after`, then audit. Plugins add hooks inside that sequence;
they cannot remove the policy or audit steps around it because those are wired by the gateway,
not registered through the context.

## Configuration

In `magentic.yaml`:

```yaml
plugins:
  disable: [web-fetch] # built-in ids to skip entirely
  use:
    - ./plugins/jira.ts # file, relative to the config directory
    - "@acme/magentic-linear" # package resolvable from the config directory
    - ["@acme/magentic-linear", { project: ENG }] # with options
tools:
  shell: false # opencode-style switch, hides the tool from every agent
```

Per-agent `tools: [...]` stays the allow-list it is now. The effective toolset for an agent is
registered tools, minus `tools: {name: false}`, intersected with the agent's list, and policy
still decides each call.

The config directory is a Bun package. External npm plugins are dependencies in
`magentic/package.json`, installed with `bun install` there and resolved from that directory,
so the lockfile is committed with the rest of the team's configuration and a deploy is still
"copy the directory". `magentic plugin add <pkg>` runs `bun add` in the config directory. No
global cache, no install at boot.

Loading an external plugin is the one place a dynamic `import` is genuinely needed: the loader
resolves the spec from the config directory, imports the module, and expects a default export
that passes a structural `isPlugin` check. Before importing it checks that the plugin's
resolved `effect` package is the gateway's own copy. Effect 4 uses string type ids
(`"~effect/ai/Tool"`), so a duplicate copy would pass `instanceof`-free checks and fail later
in schema decoding; refusing the mismatch up front with a message naming both paths is the
opencode compatibility gate, applied to the dependency that actually matters.

External plugins run in-process with the gateway's privileges. That is the same trust level as
editing `policy.yaml`, and it is documented as such: a plugin is code your team ships, reviewed
like the rest of the config directory. What the design guarantees is narrower and worth
stating: a plugin cannot register a tool without a capability, cannot bypass policy or audit
for calls that go through the registry, and cannot outlive being disabled.

## MCP servers

Tools from Model Context Protocol servers come through one plugin, `mcp` in `@magentic/mcp`,
the way pi keeps MCP out of its core and leaves it to an extension. The gateway reads the
`mcp:` section of `magentic.yaml` and hands it to the plugin as its options; nothing else in
the gateway knows the protocol. Each entry is a server, local (a command the gateway starts
and talks to over stdio) or remote (a URL, Streamable HTTP first and SSE when that fails):

```yaml
mcp:
  linear:
    type: remote
    url: https://mcp.linear.app/mcp
    headers: { Authorization: Bearer ... }
  files:
    type: local
    command: [npx, -y, "@modelcontextprotocol/server-filesystem", .]
    cwd: . # relative to the workspace
    environment: { LOG_LEVEL: debug } # added to a safe default environment
    timeout: 30000 # ms for the handshake and for each call
  archive:
    type: remote
    url: https://archive.example/mcp
    enabled: false
```

What the plugin does with a server, following opencode's `MCP` service:

- Connects to every enabled server concurrently at setup, with the entry's timeout. One that
  cannot be reached, or whose entry does not decode, is logged and skipped; the others keep
  working and the plugin stays active.
- Lists the server's tools and registers each as `<server>_<tool>` (anything outside
  `[a-zA-Z0-9_-]` becomes `_`; two names that collapse to the same string get a numbered
  suffix, logged), a `Tool.dynamic` carrying the server's own JSON Schema, so the model sees
  the schema the server published and the server validates the arguments. Strict schema mode
  is off for these: OpenAI's rejects any optional property, and servers rarely write for it.
  The arguments decode through a struct with one optional JSON slot per declared property,
  since the OpenAI provider derives a codec from the decoder when a call comes back and cannot
  from the `Schema.Unknown` a JSON-Schema tool carries; a key the server did not declare is
  dropped there.
  Every one declares the `mcp` capability: the gateway cannot tell what a foreign tool does,
  so policy rules say `mcp: approval` rather than reasoning per tool. MCP's `readOnlyHint`
  and the other hints become Effect's `Tool.Readonly`, `Destructive`, `Idempotent`, and
  `OpenWorld` annotations.
- Returns the text of a result as one string when that is all there is, the structured
  content when there is no text, and otherwise every block, with images and audio described
  (`{ type, mimeType, omitted }`) rather than copied into the context. A result marked
  `isError`, a protocol error, and a lost server all reach the model as `McpToolError`.
- Re-lists and re-registers when the server sends `tools/list_changed`, coalescing a burst
  into one republish; when the new listing cannot be registered the old tools are put back
  rather than left missing. Withdraws the tools when the connection closes. The server's
  `notifications/message` log lines land in the gateway log under its name.
- Appends the server's `instructions`, when it sent any, to the prompt of every agent that
  can see at least one of its tools, as a section naming the server and those tools. The
  text is framed as the server's notes about its tools, third-party content that cannot
  override the prompt above it or grant anything. That is an agent transform, so it replays
  with the rest and follows the tool list.
- Answers `roots/list` with the workspace.
- Pipes a local server's stderr into the gateway's log, one line each as
  `mcp <server> [stderr]: ...`, rather than letting the child inherit the terminal: a gateway
  embedded in the full-screen chat would otherwise have the server's logs drawn over the
  transcript.
- Reports where each server stands to `McpServers`, a service in the same package: `connected`
  with its registered tools, `disabled`, `failed` with the decode or handshake error, or
  `closed` once a connected server went away. A listing that could not be registered leaves
  the server `connected` with the error beside the tools it still offers. The gateway serves
  the table as the `listMcpServers` RPC, and `/mcp` in the CLI
  (`apps/cli/src/commands/Mcp.ts`, over `ChatSession.mcpServers`) prints it: one line per
  server with its standing, the command line or URL under it, and the error when there is
  one, so a missing tool is explained in the chat rather than in the gateway log.
  `/mcp <server>` adds the tools that server offers.

An agent lists MCP tools like any other, by name, as `<server>_*` for everything a server
offers, or as `mcp:*` for every tool from every server: an entry in `tools:` that ends in `*`
matches by prefix, and a capability followed by `:*` matches by capability. The client is the official
`@modelcontextprotocol/client` (v2), wrapped in Effect: Effect 4 ships the MCP schemas and a
server but no client, and a hand-rolled one would have to reimplement Streamable HTTP, SSE,
and stdio on top of an rc. Prompts, resources, sampling, elicitation, and OAuth sign-in for
remote servers are not wired; a bearer token in `headers` covers the remote servers that need
one today.

## The GitHub bridge

`@magentic/bridge-github` (`packages/bridge-github`) is the first bridge, and the plugin is
also a tool provider: a team that only ever mentions the bot in Slack still installs it for
the forge tools. It is configured in its `plugins.use` entry; the App's private key and the
webhook secret come from the environment (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`).

```yaml
plugins:
  use:
    - - "@magentic/bridge-github"
      - app: { id: 123456, slug: magentic-bot }
        delivery: webhook # webhook | poll
        agent: github # the agent a mention runs; created with a default prompt when no agents/github.yaml exists
        trigger: { mention: true, command: /magentic, label: null, assignee: null }
        allow: { minimum: write, logins: [] }
        public: { admit: false }
        branch: { prefix: magentic/ }
        progress: { after: collapse } # edit | collapse | delete | keep
```

What it does, and where:

- **Identity** (`GitHubApi.ts`): a GitHub App. JWTs signed with the private key, installation
  tokens minted per repository (`POST /app/installations/{id}/access_tokens` narrowed with
  `repositories`) and cached until ten minutes before expiry, never written to disk. Every
  call retries transient failures and backs off on secondary rate limits.
- **Delivery** (`Webhook.ts`, `Polling.ts`): the webhook at `/plugins/github/webhook` verifies
  `X-Hub-Signature-256` on the raw body, drops deliveries it has seen (`state.json` under
  the data directory), and answers 202 with the delivery on a queue. On start and hourly it
  lists `GET /app/hook/deliveries` and asks for the failed ones again, since GitHub will not.
  `delivery: poll` sweeps each repository's issue and review comments since a watermark
  instead; it sees comments and nothing else.
- **Trigger** (`Events.ts`): `issue_comment.created`, `pull_request_review_comment.created`,
  `pull_request_review.submitted`, `issues.opened|assigned|labeled`, `pull_request.opened`;
  the sender must be a `User`; the body must mention `@<slug>` or start with the command,
  or the assignee or label must be the configured one. The conversation is
  `github-<owner>-<repo>-<issue|pr>-<n>`, so every mention on a thread continues it.
- **Admission** (`Bridge.ts`): the person's permission from
  `GET /repos/{o}/{r}/collaborators/{login}/permission` (cached five minutes; `NONE`
  association skips the call) and org membership become groups `github:<permission>`,
  `github:org-member`, `github:allowed`. The plugin's own floor is `allow.minimum` or an
  `allow.logins` entry; policy then decides as for any surface. Public repositories are
  ignored unless `public.admit` is set. A mention while a run is live on the thread is
  steered into it.
- **Input**: the thread quoted section by section (`renderContext`): the issue or pull
  request, the comments since the bot last ran, the diff hunk for a review comment, and the
  mention last. What the person typed is never the system prompt.
- **Reporting**: an eyes reaction on the comment; on a pull request a check run named
  `magentic` on the head; one progress comment created at the first tool call and edited at
  most every ten seconds. GitHub mails a comment when it is created and never again, so the
  answer is a new comment (a reply on the diff when the mention was there) rather than an
  edit of the progress one, which would leave every watcher's mail showing a half-finished
  run; the progress comment folds into a `<details>` log of the tool calls, or is deleted
  under `progress: { after: delete }`. Its opening line says the answer will follow, since
  that line is what the mail freezes. The check run completes `success` after a push,
  `neutral` otherwise, `failure` on a failed run, and a failure posts the message and the
  run id, never the stack, leaving the progress comment expanded as the breadcrumb. When the
  agent's last tool call was `forge_comment` on the same thread, the answer is not posted
  again.
- **Tools** (`Tools.ts`): `forge_read` (`forge:read`); `forge_comment`, `forge_review_comment`
  (with a `suggestion` block), `forge_checkout`, `forge_push`, `forge_open_pr` (`forge:write`).
  They take the repository as a parameter and mint their own token, so a run started from
  the CLI can use them too. The workspace is the one repository's checkout: `forge_checkout`
  fetches the pull request's branch or starts one under `branch.prefix` from the default
  branch, and sets the bot's `user.name` and `user.email` so pushed commits show the bot;
  `forge_push` refuses any branch but those and the pull request's own, runs `git push`
  itself with the token in that one process's environment, never the model's; and
  `forge_open_pr` opens a draft, `Closes #N` appended when asked. A pull request from a fork
  is answered with comments and suggestions, never pushes. There is no tool to mark a pull
  request ready, approve, or merge.
- **The agent**: the configured name gets the bridge's prompt section and the forge tools
  added when `agents/<name>.yaml` exists, and a default agent otherwise.

Not built: the manifest install flow (`magentic github install`, waiting on a decision about
the CLI surface; register the App by hand with Metadata read, Issues write, Pull requests
write, Contents write, Checks write, and the events above), the PAT demo mode, a worktree
per conversation, and containers.

## The built-ins, rewritten as plugins

A tool's parameters must render as a JSON Schema of type `object`; the host refuses a
toolkit with one that does not, naming the tool. An empty `Schema.Struct({})` is the usual
way to trip this (Effect renders it as `anyOf` object or array, which OpenAI-style providers
reject at every model call): give a tool that takes nothing at least one optional parameter.

- `@magentic/tools`: `fileTools` plugin registering `read_file`, `write_file`, `edit_file`,
  `list_dir`, `glob`, and `grep` from the existing `FileToolsLayer`. `shell` and `http_fetch` arrive as their own plugins so they can
  be disabled individually; the `shell` plugin also registers `task_output`, `task_stop`,
  and `task_list` for commands it left running in the background, and takes the
  `BackgroundTasks` and `ToolOutputDir` it runs them with from the host, which keeps the
  tasks in its own scope so it can list them for a surface too.
- `@magentic/mcp`: the `mcp` plugin above, given the `mcp:` section as its options.
- `@magentic/model`: `openaiCodex`, `openai`, `anthropic`, `zai`, `opencodeZen` plugins, each one
  `ModelProviderRegistration`. `Providers.ts` in the CLI is deleted; `magentic auth login`
  builds its picker from the model domain of a local `PluginHost` with the built-ins only,
  since sign-in is a local operation and needs no gateway.
- The gateway: `assistant` with the built-in agent, `config-agents` for `agents/*.yaml`.

`Server.ts` lists them as `builtinPlugins` (file tools, shell, the providers, `assistant`),
then `config-agents`, `mcp`, and the external plugins from `plugins.use`, in that order.
Nothing else in the gateway changes shape.

## CLI

- `magentic plugin list`: id, source (built-in, file, package), status (active, disabled,
  failed with reason), and what it contributed (tool names, provider ids, agent names).
- `magentic plugin add <pkg>` and `remove <pkg>`, editing `plugins.use` and running `bun`
  in the config directory.

## Status

Done, with tests beside the code:

- `@magentic/plugin`: `define`, `PluginContext` with the tool, model, agent, and event domains,
  `ToolCallContext`, `CapabilityAnnotation`, the login types, `AgentDefinition`.
- `@magentic/core`: `PluginHost.layer` (scoped registrations, ordered registries, boot batch,
  agent transforms with `rebuild`, failed plugins isolated and reported), `ToolRegistry` with
  `ToolCallGuard` around every call, `ModelRegistry.layerLanguageModel`, `RunEventBus`,
  `GatewayConfig` for `plugins` and `tools` in `magentic.yaml`. `ModelCatalog` with the
  models.dev snapshot and cached refresh; `provider/model` references.
- Built-ins as plugins: `fileToolsPlugin`, `openaiCodexPlugin`, `openaiPlugin`,
  `anthropicPlugin`, `zaiPlugin` (GLM through Z.AI's Anthropic-compatible endpoint),
  `opencodeZenPlugin` (Claude through OpenCode Zen's Anthropic-compatible route), and the
  gateway's `assistantPlugin`.
- Gateway: `ToolCallGuardLive` (policy per call, `tool.called` / `tool.failed` /
  `tool.denied` audit events), the config and plugin loader, the `listPlugins` RPC.
- CLI: `magentic plugin list`; `auth login|list|logout` read providers from a local host.
- `configAgentsPlugin` in the gateway: `agents/*.yaml` from the configuration directory
  (`name`, `description`, `model`, `prompt` inline or `{ file }`, `tools`, `maxSteps`), one bad file
  logged with its path and field while the rest load, rebuilt on SIGHUP and, with
  `reload: watch` in `magentic.yaml`, on file changes.
- `model:` on an agent picks a provider by id; `ModelRegistry.languageModel` builds each
  provider's model once and falls back to the first signed-in provider.
- Commands: `ctx.command.register`, `CommandRegistry` from the host, `commands` on
  `PluginInfo`, `model` on `RunRequest`. `modelCommandPlugin` in `@magentic/model` is `/model`;
  the CLI chat runs it from its local host and draws the picker in the TUI.

- `mcpPlugin` in `@magentic/mcp`: the `mcp:` section, local and remote servers, tools as
  `<server>_<tool>` with the `mcp` capability, list-changed and close handling, server
  instructions on the agents that see the tools, and `<server>_*` or `mcp:*` in an agent's
  `tools:`.

- Bridges: the `bridge` and `http` domains, `BridgeBackend` and `PluginRoutes` from the host,
  the gateway's `BridgesLayer` that mints `system:bridge/<surface>` principals and admits
  runs, the `/plugins/:plugin/*` route, open surface and provider names, `onBehalfOf` on
  `Principal`, the `forge:read` and `forge:write` capabilities, `trackProgress` and
  `deliverAnswer` with the capabilities that pick a delivery, and `@magentic/bridge-github`.
  The shell tool blanks `GH_TOKEN`, `GITHUB_TOKEN`, and `GIT_ASKPASS` for every run and
  points `GH_CONFIG_DIR` away from the operator's login for runs on behalf of someone.

Still open: `magentic plugin add|remove`, `magentic github install`, and a reload endpoint,
all waiting on a decision about the CLI surface.

**Resolving a plugin's imports.** A file plugin imports `effect` and `@magentic/plugin` from
its own location. Bun's runtime resolve hook does not intercept bare package imports, so the
gateway cannot redirect them; the plugin's directory has to resolve those names to the
gateway's copies on its own. Inside this repository that holds for any config directory,
because the root links both packages. A deployed config directory is a Bun package that
depends on `magentic` and `@magentic/plugin`, and the gateway runs from it, so there is one
`node_modules` and one `effect`. The loader still checks and refuses a second copy.
