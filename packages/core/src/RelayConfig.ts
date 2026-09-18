import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { dataDir } from "./Paths.ts";

export class RelayConfigError extends Schema.TaggedError<RelayConfigError>()("RelayConfigError", {
  message: Schema.String,
}) {}

export class RelayConfig extends Schema.Class<RelayConfig>("magentic/core/RelayConfig")({
  url: Schema.String,
  token: Schema.String,
  publicUrl: Schema.optional(Schema.String),
}) {}

/** Credentials are provisioned once, separately from the public gateway configuration. */
export const relayConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = `${yield* dataDir}/relay.json`;
  const url = yield* Config.String("MAGENTIC_RELAY_URL").pipe(Config.option);
  const token = yield* Config.String("MAGENTIC_RELAY_TOKEN").pipe(Config.option);
  const publicUrl = yield* Config.String("MAGENTIC_REMOTE_URL").pipe(Config.option);
  if (Option.isSome(url) && Option.isSome(token)) {
    return Option.some(
      new RelayConfig({
        url: url.value,
        token: token.value,
        publicUrl: Option.getOrElse(publicUrl, () => url.value),
      }),
    );
  }
  if (Option.isSome(url) || Option.isSome(token)) {
    return yield* new RelayConfigError({
      message: "Set both MAGENTIC_RELAY_URL and MAGENTIC_RELAY_TOKEN.",
    });
  }
  if (!(yield* fs.exists(file))) return Option.none<RelayConfig>();
  return Option.some(
    yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RelayConfig)))),
  );
});
