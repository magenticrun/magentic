export * as Codex from "./codex/index.ts";
export * from "./ApiKeys.ts";
export * from "./Fake.ts";
export * from "./ModelProvider.ts";
export * from "./plugins/ApiKeyProviders.ts";
export * from "./plugins/OpenAiCodex.ts";
export * from "./plugins/AnthropicCompat.ts";
export * from "./Stores.ts";

import type { ModelCatalog, Plugin } from "@magentic/plugin";
import type { FileSystem } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { ApiKeyStore } from "./ApiKeys.ts";
import type { CodexAuthStore } from "./codex/CodexAuthStore.ts";
import {
  anthropicPlugin,
  opencodeZenPlugin,
  openaiPlugin,
  zaiPlugin,
} from "./plugins/ApiKeyProviders.ts";
import { openaiCodexPlugin } from "./plugins/OpenAiCodex.ts";

/** What hosting every provider plugin takes: both credential stores plus platform services. */
export type ModelPluginServices =
  | CodexAuthStore
  | ApiKeyStore
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelCatalog;

/** Every provider we ship, in the order `magentic auth login` lists them and the runner tries them. */
export const modelPlugins: ReadonlyArray<Plugin<ModelPluginServices>> = [
  openaiCodexPlugin,
  openaiPlugin,
  anthropicPlugin,
  zaiPlugin,
  opencodeZenPlugin,
];
