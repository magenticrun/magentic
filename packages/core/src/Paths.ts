import { Config, Effect, Path } from "effect";

/**
 * Where magentic keeps its files. The gateway and the CLI read the same two
 * directories, so the CLI need not load the server to learn them.
 */

/** The configuration directory. `./magentic` beside where the gateway runs, unless told otherwise. */
export const configDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dir = yield* Config.string("MAGENTIC_HOME").pipe(Config.withDefault("./magentic"));
  return path.resolve(dir);
});

/** Per-person state outside the config directory, beside the credential files. */
export const dataDir = Config.string("MAGENTIC_DATA_DIR").pipe(
  Config.orElse(() => Config.map(Config.string("HOME"), (home) => `${home}/.config/magentic`)),
);
