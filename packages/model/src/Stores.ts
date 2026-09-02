import { Effect, Layer } from "effect";
import { ApiKeyStore, apiKeysFile } from "./ApiKeys.ts";
import { CodexAuthStore } from "./codex/CodexAuthStore.ts";
import { codexAuthFile } from "./codex/CodexConfig.ts";

/** Both credential stores on disk, at the paths the config points to. */
export const layerCredentialStores = Layer.mergeAll(
  Layer.unwrap(Effect.map(codexAuthFile, CodexAuthStore.layerFile)),
  Layer.unwrap(Effect.map(apiKeysFile, ApiKeyStore.layerFile)),
);
