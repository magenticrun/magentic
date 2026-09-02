import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Audit } from "@magentic/audit";
import { AgentDefinition, builtin, ConversationStore, PluginHost, Runner } from "@magentic/core";
import { Identity } from "@magentic/identity";
import { layerCredentialStores, modelPlugins } from "@magentic/model";
import { define, ModelCatalog } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { Api } from "@magentic/protocol";
import { fileToolsPlugin, WorkspaceRoot } from "@magentic/tools";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, FetchHttpClient } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { configAgentsPlugin } from "./ConfigAgents.ts";
import { ToolCallGuardLive } from "./Guard.ts";
import { AgentsApiHandlersNoDeps, PluginsApiHandlers, SystemApiHandlers } from "./Handlers.ts";
import { configDir, loadExternalPlugin, loadGatewayConfig } from "./Plugins.ts";

/** The one agent every gateway has until `agents/*.yaml` exists. */
export const assistant = new AgentDefinition({
  name: "assistant",
  description: "General assistant that can read and write files in the workspace.",
  prompt:
    "You are magentic, a capable assistant working inside a software workspace. " +
    "Use read_file to look at files before answering questions about them and " +
    "write_file when asked to create or change a file. Paths are relative to the workspace root. " +
    "Be concise.",
  tools: ["read_file", "write_file"],
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
    const external = yield* Effect.forEach(config.externalPlugins, (spec) =>
      loadExternalPlugin(dir, spec),
    );
    const fromConfig = builtin(configAgentsPlugin({ dir, watch: config.reload === "watch" }));
    return PluginHost.layer({
      plugins: [...builtinPlugins, fromConfig, ...external],
      disabled: config.disabledPlugins,
      disabledTools: config.disabledTools,
      paths: { config: dir, workspace },
    });
  }),
);

/** Conversations behind the runner; tools, models, and events come from the host. */
export const RunnerLayer = Runner.layer.pipe(Layer.provide(ConversationStore.layerMemory));

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

export const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([
    SystemApiHandlers,
    Layer.mergeAll(AgentsApiHandlersNoDeps, PluginsApiHandlers).pipe(Layer.provide(ServicesLayer)),
  ]),
);

export const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

export const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute);

/** The whole gateway on one port. Building the layer starts serving. `quiet` drops request logs. */
export const layerServer = (port: number, options: { readonly quiet?: boolean } = {}) =>
  HttpRouter.serve(AllRoutes, {
    disableLogger: options.quiet === true,
    disableListenLog: options.quiet === true,
  }).pipe(
    Layer.provide(BunHttpServer.layer({ port })),
    Layer.provide([BunServices.layer, FetchHttpClient.layer]),
  );

/** `Layer.launch` this to run the gateway on `PORT`. */
export const HttpServerLayer = Layer.unwrap(
  Effect.map(Config.port("PORT").pipe(Config.withDefault(4321)), layerServer),
);
