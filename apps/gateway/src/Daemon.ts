import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { layerServer } from "./Server.ts";

Effect.gen(function* () {
  const port = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(process.argv[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return yield* Effect.die("Invalid gateway port");
  return yield* Layer.launch(layerServer(port, { quiet: true }));
}).pipe(BunRuntime.runMain);
