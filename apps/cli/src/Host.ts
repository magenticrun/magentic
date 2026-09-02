import { configDir, dataDir } from "@magentic/gateway/paths";
import { builtin, PluginHost, ToolCallGuard } from "@magentic/core";
import {
  contextCommandPlugin,
  layerCredentialStores,
  modelCommandPlugin,
  modelPlugins,
} from "@magentic/model";
import { ModelCatalog } from "@magentic/plugin";
import { Effect, Layer } from "effect";
import { conversationCommandsPlugin } from "./commands/Conversations.ts";

/**
 * The plugins that run beside the CLI itself: the providers, for signing in
 * against the credential stores on disk, and the slash commands a chat
 * offers. Neither needs a gateway; the gateway hears of a chosen model with
 * each run request.
 */
export const LocalHost = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* configDir;
    const data = yield* dataDir;
    return PluginHost.layer({
      plugins: [
        ...modelPlugins.map(builtin),
        builtin(modelCommandPlugin),
        builtin(contextCommandPlugin),
        builtin(conversationCommandsPlugin),
      ],
      paths: { config, workspace: process.cwd(), data },
    });
  }),
).pipe(Layer.provide([layerCredentialStores, ModelCatalog.layer, ToolCallGuard.layerAllowAll]));
