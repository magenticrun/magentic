import {
  GatewayConfig,
  type LoadedPlugin,
  type PluginSpec,
  specName,
  specOptions,
} from "@magentic/core";
import { messageOf, type Plugin, type PluginServices, PluginSetupError } from "@magentic/plugin";
import type { PluginSource } from "@magentic/protocol";
import { Config, Effect, FileSystem, Path, Predicate, Schema } from "effect";

export class GatewayConfigError extends Schema.TaggedError<GatewayConfigError>()(
  "GatewayConfigError",
  { file: Schema.String, message: Schema.String },
) {}

/** `magentic.yaml` from the directory, or the empty config when there is none. */
export const loadGatewayConfig = Effect.fn("Gateway.loadConfig")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${dir}/magentic.yaml`;
  const failed = (error: { readonly message: string }) =>
    new GatewayConfigError({ file, message: error.message });
  if (!(yield* fs.exists(file).pipe(Effect.mapError(failed)))) {
    return GatewayConfig.empty;
  }
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(failed));
  const parsed = yield* Effect.try({
    try: () => Bun.YAML.parse(text),
    catch: (error) => failed({ message: messageOf(error) }),
  });
  return yield* Schema.decodeUnknownEffect(GatewayConfig)(parsed).pipe(Effect.mapError(failed));
});

/** The shape a plugin module's default export must have before we trust it as a `Plugin`. */
const PluginModule = Schema.Struct({
  default: Schema.Struct({
    id: Schema.NonEmptyString,
    description: Schema.String,
    setup: Schema.Unknown,
  }),
});

const isFileSpec = (name: string) =>
  name.startsWith(".") || name.startsWith("/") || name.startsWith("file:");

/** A plugin that only reports why it could not be loaded, so `plugin list` shows it. */
const unloadable = (id: string, source: PluginSource, message: string): LoadedPlugin => ({
  plugin: {
    id,
    description: "",
    setup: () => Effect.fail(new PluginSetupError({ plugin: id, message })),
  },
  source,
});

const resolveFrom = (specifier: string, from: string) =>
  Effect.try({
    try: () => Bun.resolveSync(specifier, from),
    catch: (error) => messageOf(error),
  });

/**
 * Resolves one `plugins.use` entry from the config directory and imports it.
 * The one dynamic import in the codebase: the plugin is not known until the
 * config is read. A plugin that resolves a different copy of `effect` than
 * the gateway is refused: a second copy carries its own schema and service
 * identities and nothing would interoperate.
 */
export const loadExternalPlugin = Effect.fn("Gateway.loadPlugin")(function* (
  dir: string,
  spec: PluginSpec,
) {
  const path = yield* Path.Path;
  const name = specName(spec);
  const source: PluginSource = isFileSpec(name) ? "file" : "package";

  const outcome = yield* Effect.gen(function* () {
    const target = isFileSpec(name)
      ? path.resolve(dir, name.replace(/^file:\/\//, ""))
      : yield* resolveFrom(name, dir);
    const hostEffect = yield* resolveFrom("effect", import.meta.dir);
    const pluginEffect = yield* resolveFrom("effect", path.dirname(target)).pipe(
      Effect.orElseSucceed(() => hostEffect),
    );
    if (pluginEffect !== hostEffect) {
      return yield* Effect.fail(
        `resolves its own copy of effect (${pluginEffect}); it must share the gateway's (${hostEffect})`,
      );
    }
    const mod = yield* Effect.tryPromise({
      try: () => import(target),
      catch: (error) => messageOf(error),
    });
    const decoded = yield* Schema.decodeUnknownEffect(PluginModule)(mod).pipe(
      Effect.mapError(() => "default export is not a plugin (needs id, description, setup)"),
    );
    if (!Predicate.isFunction(decoded.default.setup)) {
      return yield* Effect.fail("default export has no setup function");
    }
    // SAFETY: the default export has a plugin's shape; its setup runs in the host's PluginServices.
    return decoded.default as Plugin<PluginServices>;
  }).pipe(Effect.result);

  const loaded: LoadedPlugin<PluginServices> =
    outcome._tag === "Success"
      ? { plugin: outcome.success, source, options: specOptions(spec) }
      : unloadable(name, source, outcome.failure);
  return loaded;
});
