import type { RunEventEnvelope } from "@magentic/plugin";
import { Context, Effect, Layer, PubSub, Stream } from "effect";

/** Every event every run emits, for observers. Runs never wait on subscribers. */
export class RunEventBus extends Context.Service<
  RunEventBus,
  {
    publish(envelope: RunEventEnvelope): Effect.Effect<void>;
    readonly stream: Stream.Stream<RunEventEnvelope>;
  }
>()("magentic/core/RunEventBus") {
  static readonly make: Effect.Effect<RunEventBus["Service"]> = Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<RunEventEnvelope>();
    return RunEventBus.of({
      publish: (envelope) => Effect.asVoid(PubSub.publish(pubsub, envelope)),
      stream: Stream.fromPubSub(pubsub),
    });
  });

  static readonly layer = Layer.effect(RunEventBus, RunEventBus.make);
}
