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
}
export interface ModelDomain {
  register(provider: ModelProviderRegistration): Effect.Effect<Registration, never, Scope.Scope>;
  /** Every provider registered so far, in plugin order. */
  readonly providers: Effect.Effect<ReadonlyArray<ModelProviderRegistration>>;
}
```

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
`f`) and loops on the answer, the way a login method reports through `LoginUi`. Any surface
that can show a list can host one.

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
nothing to offer, so it is not listed), a provider's models on selection, `f` to favourite
or unfavourite, and `/model provider/model` to set it outright. The CLI remembers the choice
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
policy, still open from phase 1, lands in `ToolRegistry.forAgent`: the returned `handle` runs
`Policy.evaluate` for the call, then the `execute.before` hooks, then the handler with
`ToolCallContext`, then `execute.after`, then audit. Plugins add hooks inside that sequence;
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
  the schema the server published and the server validates the arguments.
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

An agent lists MCP tools like any other, by name, or as `<server>_*` for everything a server
offers: an entry in `tools:` that ends in `*` matches by prefix. The client is the official
`@modelcontextprotocol/client` (v2), wrapped in Effect: Effect 4 ships the MCP schemas and a
server but no client, and a hand-rolled one would have to reimplement Streamable HTTP, SSE,
and stdio on top of an rc. Prompts, resources, sampling, elicitation, and OAuth sign-in for
remote servers are not wired; a bearer token in `headers` covers the remote servers that need
one today.

## The built-ins, rewritten as plugins

- `@magentic/tools`: `fileTools` plugin registering `read_file`, `write_file`, `edit_file`,
  `list_dir`, `glob`, and `grep` from the existing `FileToolsLayer`. `shell` and `http_fetch` arrive as their own plugins so they can
  be disabled individually.
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
  instructions on the agents that see the tools, and `<server>_*` in an agent's `tools:`.

Still open: `magentic plugin add|remove` and a reload endpoint, both waiting on a decision
about the CLI surface.

**Resolving a plugin's imports.** A file plugin imports `effect` and `@magentic/plugin` from
its own location. Bun's runtime resolve hook does not intercept bare package imports, so the
gateway cannot redirect them; the plugin's directory has to resolve those names to the
gateway's copies on its own. Inside this repository that holds for any config directory,
because the root links both packages. A deployed config directory is a Bun package that
depends on `magentic` and `@magentic/plugin`, and the gateway runs from it, so there is one
`node_modules` and one `effect`. The loader still checks and refuses a second copy.
