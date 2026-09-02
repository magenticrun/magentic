import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Audit } from "@magentic/audit";
import { AgentDefinition, builtin, ConversationStore, PluginHost, Runner } from "@magentic/core";
import { Identity } from "@magentic/identity";
import { layerCredentialStores, modelPlugins } from "@magentic/model";
import { define, ModelCatalog } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { Api, RPC_PATH } from "@magentic/protocol";
import { fileToolsPlugin, shellToolPlugin, WorkspaceRoot } from "@magentic/tools";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { configAgentsPlugin } from "./ConfigAgents.ts";
import { ToolCallGuardLive } from "./Guard.ts";
import { RpcHandlers } from "./Handlers.ts";
import { configDir, dataDir } from "./Paths.ts";
import { loadExternalPlugin, loadGatewayConfig } from "./Plugins.ts";

/** The one agent every gateway has until `agents/*.yaml` exists. */
export const assistant = new AgentDefinition({
  name: "assistant",
  description: "General assistant that can explore, change, and run things in the workspace.",
  prompt: `You are magentic, an assistant working inside a software workspace.

Your tools are read_file, write_file, edit_file, list_dir, glob, grep, and shell. They are the only way you can see or change the workspace.

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

Answering:
- Be concise and direct. Lead with the answer; skip preamble and closing summaries.
- Prefer accuracy over agreement. Check before confirming a belief, and say plainly when something is wrong.
- Cite code as path:line so people can jump to it.
- Use GitHub-flavored markdown. No emojis unless asked.
- After a change, say what you changed, what you ran, and what you could not verify.
- Do not add comments or documentation unless asked. Never write secrets into files.`,
  tools: ["read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "shell"],
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

/** What we ship, in the order their contributions take. External plugins follow. */
export const builtinPlugins = [
  builtin(fileToolsPlugin),
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
    return PluginHost.layer({
      plugins: [...builtinPlugins, fromConfig, ...external],
      disabled: config.disabledPlugins,
      disabledTools: config.disabledTools,
      paths: { config: dir, workspace, data },
    });
  }),
);

/** Conversations on disk under the data directory, so they outlive the gateway. */
export const ConversationStoreLayer = Layer.unwrap(
  Effect.map(dataDir, (data) => ConversationStore.layerFile(`${data}/conversations`)),
);

/** Conversations behind the runner, and beside it for listing; tools, models, and events come from the host. */
export const RunnerLayer = Runner.layer.pipe(Layer.provideMerge(ConversationStoreLayer));

const AdmissionLayer = Layer.mergeAll(Identity.layerLocal, Policy.layerAllowAll, Audit.layerMemory);

/** Identity, policy, and audit meet the runner here and nowhere else. */
export const ServicesLayer = Layer.mergeAll(RunnerLayer, AdmissionLayer).pipe(
  Layer.provideMerge(
    HostLayer.pipe(
      Layer.provide([
        WorkspaceLayer,
        layerCredentialStores,
        ModelCatalog.layer,
        ToolCallGuardLive.pipe(Layer.provide(AdmissionLayer)),
      ]),
    ),
  ),
);

/** The RPCs at `/rpc`: newline-delimited JSON, a run's events streamed in the response body. */
export const RpcRoute = RpcServer.layerHttp({ group: Api, path: RPC_PATH, protocol: "http" }).pipe(
  Layer.provide([RpcHandlers.pipe(Layer.provide(ServicesLayer)), RpcSerialization.layerNdjson]),
);

/** For anything that only wants to know the gateway is up, curl included. */
export const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.empty());

export const AllRoutes = Layer.mergeAll(RpcRoute, HealthRoute);

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
