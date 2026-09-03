import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect";

/**
 * What the harness has to tell the model about a conversation, as opposed
 * to what the person typed: a background command ended, for one. A plugin
 * posts a notice; the runner takes what is pending before each model call
 * and once more when the model has answered, so a notice that lands during
 * a run reaches the model before it speaks again, or makes it speak once
 * more. One that lands between runs is announced on `posted`, for the
 * gateway to start a run on when a surface is following the conversation;
 * otherwise it waits for the next input to the conversation.
 */
export class Notices extends Context.Service<
  Notices,
  {
    /** Queue a notice for the conversation's next model call. */
    post(conversationId: string, text: string): Effect.Effect<void>;
    /** What is pending for the conversation, oldest first; empty from then on. */
    take(conversationId: string): Effect.Effect<ReadonlyArray<string>>;
    /** The conversation of each notice as it lands, for whoever would wake the model on it. */
    readonly posted: Stream.Stream<string>;
  }
>()("magentic/plugin/Notices") {
  static readonly layer = Layer.effect(
    Notices,
    Effect.gen(function* () {
      const pending = yield* Ref.make(new Map<string, ReadonlyArray<string>>());
      const landed = yield* PubSub.unbounded<string>();
      return Notices.of({
        post: (conversationId, text) =>
          Ref.update(pending, (all) =>
            new Map(all).set(conversationId, [...(all.get(conversationId) ?? []), text]),
          ).pipe(Effect.andThen(PubSub.publish(landed, conversationId)), Effect.asVoid),
        take: (conversationId) =>
          Ref.modify(
            pending,
            (all): [ReadonlyArray<string>, Map<string, ReadonlyArray<string>>] => {
              const taken = all.get(conversationId);
              if (taken === undefined) {
                return [[], all];
              }
              const next = new Map(all);
              next.delete(conversationId);
              return [taken, next];
            },
          ),
        posted: Stream.fromPubSub(landed),
      });
    }),
  );
}
