import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Audit } from "@magentic/audit";
import {
  AgentDefinition,
  builtin,
  configDir,
  ConversationStore,
  dataDir,
  PluginHost,
  Runner,
  Steering,
} from "@magentic/core";
import { Identity } from "@magentic/identity";
import { mcpPlugin, McpServers } from "@magentic/mcp";
import { layerCredentialStores, modelPlugins } from "@magentic/model";
import { define, ModelCatalog, Notices } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { Api, RPC_PATH } from "@magentic/protocol";
import {
  BackgroundTasks,
  fileToolsPlugin,
  shellToolPlugin,
  ToolOutputDir,
  WorkspaceRoot,
} from "@magentic/tools";
import { Config, Effect, type FileSystem, Layer, type Path, Schema } from "effect";
import {
  FetchHttpClient,
  type HttpClient,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { configAgentsPlugin } from "./ConfigAgents.ts";
import { ToolCallGuardLive } from "./Guard.ts";
import { RpcHandlers } from "./Handlers.ts";
import { loadExternalPlugin, loadGatewayConfig } from "./Plugins.ts";
import { Wakeups } from "./Wakeups.ts";

/** The one agent every gateway has until `agents/*.yaml` exists. */
export const assistant = new AgentDefinition({
  name: "assistant",
  description: "General assistant that can explore, change, and run things in the workspace.",
  prompt: `You are magentic, an assistant working inside a software workspace.

Your tools are read_file, write_file, edit_file, list_dir, glob, grep, and shell, with task_output, task_stop, and task_list for commands shell left running in the background. The file tools and shell are the only way you can see or change the workspace.

Working with files:
- Paths are relative to the workspace root.
- Find files with glob and contents with grep; list_dir shows what one directory holds. grep reports line numbers, read_file returns the whole file.
- Read a file before you answer questions about it or change it. Never guess at contents.
- Prefer edit_file for an existing file. Include enough surrounding lines to make oldString unique, or set replaceAll for a rename.
- Use write_file only for a new file or a full rewrite. Do not create files the task does not need.
- Match the surrounding code: its conventions, style, and libraries. Check that a library is already used before importing it.
- Call independent tools in parallel. Chain calls only when one needs another's result.
- glob, grep, and list_dir cap their results and report truncated. Narrow with path or include when you hit the cap.

Running commands:
- shell runs one command line through sh in the workspace, with no terminal and no stdin. Pass non-interactive flags; anything that prompts will hang until it is killed.
- Use shell for git, package managers, tests, builds, and scripts. Use the file tools for files, not cat, grep, find, or sed.
- Set workdir instead of cd. Chain dependent commands with &&; run independent ones as parallel calls.
- Verify your changes with the project's own commands when it has them, such as its typecheck, lint, or test scripts. Read package.json or the README to find them; do not guess.
- Never commit, push, or change git configuration unless asked. Stage only the files you changed.
- Do not run anything that reaches outside the workspace or deletes things wholesale unless asked.
- For a server, a watcher, or a run that takes a while, set background to true: the call returns a taskId at once and you carry on. You are told when the task ends, so do not poll it; task_output reads what it printed or waits for it when you need the result now, task_stop ends it, and task_list names the ones you started. Stop a server you started once you are done with it, unless asked to leave it running.

Answering:
- Be concise and direct. Lead with the answer; skip preamble and closing summaries.
- Prefer accuracy over agreement. Check before confirming a belief, and say plainly when something is wrong.
- Cite code as path:line so people can jump to it.
- Use GitHub-flavored markdown. No emojis unless asked.
- After a change, say what you changed, what you ran, and what you could not verify.
- Do not add comments or documentation unless asked. Never write secrets into files.`,
  tools: [
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "glob",
    "grep",
    "shell",
    "task_output",
    "task_stop",
    "task_list",
  ],
});

export const assistantPlugin = define({
  id: "assistant",
  description: "The built-in general assistant agent.",
  setup: (ctx) =>
    Effect.asVoid(ctx.agent.transform((draft) => Effect.sync(() => draft.set(assistant)))),
});

/** Directory the file tools may touch. Defaults to where the gateway was started. */
const workspaceRoot = Config.string("MAGENTIC_WORKSPACE").pipe(Config.withDefault(process.cwd()));

const WorkspaceLayer = Layer.unwrap(Effect.map(workspaceRoot, WorkspaceRoot.layer));

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

/** What we ship, in the order their contributions take. External plugins follow. */
export const builtinPlugins = [
  builtin(fileToolsPlugin),
  builtin(shellToolPlugin),
  ...modelPlugins.map(builtin),
  builtin(assistantPlugin),
];

/** Reads `magentic.yaml`, loads the plugins it names, and hosts them with the built-ins. */
export const HostLayer = Layer.unwrap(
  Effect.gen(function* () {
    const dir = yield* configDir;
    const config = yield* loadGatewayConfig(dir);
    const workspace = yield* workspaceRoot;
    const data = yield* dataDir;
    const external = yield* Effect.forEach(config.externalPlugins, (spec) =>
      loadExternalPlugin(dir, spec),
    );
    const fromConfig = builtin(configAgentsPlugin({ dir, watch: config.reload === "watch" }));
    // After the config agents, so the servers' instructions reach every agent that can see their tools.
    const mcp = builtin(mcpPlugin, config.mcpServers);
    return PluginHost.layer({
      plugins: [...builtinPlugins, fromConfig, mcp, ...external],
      disabled: config.disabledPlugins,
      disabledTools: config.disabledTools,
      paths: { config: dir, workspace, data },
    });
  }),
);

/**
 * Background tasks in the gateway's own scope, with the full outputs of
 * commands beside the conversations under the data directory: the shell
 * plugin runs them, and the handlers list them for a surface.
 */
export const BackgroundTasksLayer = BackgroundTasks.layer.pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(dataDir, (data) => ToolOutputDir.layer(`${data}/tool-output`))),
  ),
);

/** Conversations on disk under the data directory, so they outlive the gateway. */
export const ConversationStoreLayer = Layer.unwrap(
  Effect.map(dataDir, (data) => ConversationStore.layerFile(`${data}/conversations`)),
);

/**
 * Conversations behind the runner, and beside it for listing, as is the
 * steering the handlers offer to; tools, models, events, and the notices
 * come from the host's side.
 */
export const RunnerLayer = Runner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ConversationStoreLayer, Steering.layer)),
);

const AdmissionLayer = Layer.mergeAll(Identity.layerLocal, Policy.layerAllowAll, Audit.layerMemory);

/** The runner with what admits a run; the wake-ups start runs through both. */
const CoreLayer = Layer.mergeAll(RunnerLayer, AdmissionLayer);

/**
 * Identity, policy, and audit meet the runner here and nowhere else. The
 * model catalog comes from outside, so a process that already has one (the
 * CLI with its embedded gateway) serves with it rather than a second copy.
 * The MCP standings the plugin reports stay visible so the handlers can
 * serve them.
 */
export const ServicesLayer = Layer.mergeAll(
  CoreLayer,
  Wakeups.layer.pipe(Layer.provide(CoreLayer)),
).pipe(
  Layer.provideMerge(
    HostLayer.pipe(
      Layer.provide([
        WorkspaceLayer,
        layerCredentialStores,
        ToolCallGuardLive.pipe(Layer.provide(AdmissionLayer)),
      ]),
      Layer.provideMerge(McpServers.layer),
    ),
  ),
  Layer.provideMerge(BackgroundTasksLayer),
  // One notice board for the runner and the wake-ups that read it and the tasks that post to it.
  Layer.provideMerge(Notices.layer),
);

/** The RPCs at `/rpc`: newline-delimited JSON, a run's events streamed in the response body. */
export const RpcRoute = RpcServer.layerHttp({ group: Api, path: RPC_PATH, protocol: "http" }).pipe(
  Layer.provide([RpcHandlers.pipe(Layer.provide(ServicesLayer)), RpcSerialization.layerNdjson]),
);

/** For anything that only wants to know the gateway is up, curl included. */
export const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.empty());

export const AllRoutes = Layer.mergeAll(RpcRoute, HealthRoute);

export interface ServerOptions {
  /** Drop request and listen logs, for a gateway embedded in another program. */
  readonly quiet?: boolean;
  readonly hostname?: string;
  /**
   * The model catalog to serve with. The CLI hands over its own, so an
   * embedded gateway does not fetch, cache, and refresh a second copy.
   */
  readonly catalog?: Layer.Layer<
    ModelCatalog,
    never,
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >;
}

/** The whole gateway on one port. Building the layer starts serving. */
export const layerServer = (port: number, options: ServerOptions = {}) =>
  HttpRouter.serve(AllRoutes, {
    disableLogger: options.quiet === true,
    disableListenLog: options.quiet === true,
  }).pipe(
    // Bun closes a request that sends nothing for ten seconds; compacting a
    // conversation waits on the model longer than that. 255 is Bun's most.
    Layer.provide(
      BunHttpServer.layer({ port, hostname: options.hostname ?? "127.0.0.1", idleTimeout: 255 }),
    ),
    Layer.provide(options.catalog ?? ModelCatalog.layer),
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
