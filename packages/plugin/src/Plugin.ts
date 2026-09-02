import type { Effect, FileSystem, Path, Scope } from "effect";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { PluginContext } from "./Context.ts";
import type { ModelCatalog } from "./Catalog.ts";

/** Raised when a plugin cannot set itself up. The host skips the plugin and keeps serving. */
export class PluginSetupError extends Schema.TaggedError<PluginSetupError>()("PluginSetupError", {
  plugin: Schema.String,
  message: Schema.String,
}) {}

/**
 * Something that contributes tools, model providers, agents, or observers.
 * `setup` runs once in a scope the host owns; everything it registers is
 * removed when that scope closes, so disabling a plugin means not running it.
 */
export interface Plugin<R = never> {
  /** Stable, unique, and what `plugins.disable` in the config names. */
  readonly id: string;
  readonly description: string;
  readonly setup: (ctx: PluginContext) => Effect.Effect<void, PluginSetupError, Scope.Scope | R>;
}

/** Pins the plugin's shape at the definition site. The scope is the host's, not a requirement. */
export const define = <R = never>(plugin: Plugin<R>): Plugin<Exclude<R, Scope.Scope>> =>
  // SAFETY: `setup` already lists Scope beside R, so removing Scope from R changes nothing it needs.
  plugin as Plugin<Exclude<R, Scope.Scope>>;

/** Handle to something a plugin registered. Disposal is idempotent. */
export interface Registration {
  readonly dispose: Effect.Effect<void>;
}

/** Services every plugin may rely on during setup, whoever hosts it. */
export type PluginServices =
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ModelCatalog;
