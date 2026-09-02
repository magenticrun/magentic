import { Context, Effect, Layer, Option, Ref } from "effect";

/**
 * Where chat history lives between runs. The value is `Chat.exportJson`
 * output, opaque to us, so it survives model provider changes.
 */
export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    load(id: string): Effect.Effect<Option.Option<string>>;
    save(id: string, chatJson: string): Effect.Effect<void>;
  }
>()("magentic/core/ConversationStore") {
  /** Lost on restart. Fine for a local gateway and for tests. */
  static readonly layerMemory = Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const chats = yield* Ref.make(new Map<string, string>());
      return ConversationStore.of({
        load: (id) => Effect.map(Ref.get(chats), (all) => Option.fromNullishOr(all.get(id))),
        save: (id, json) => Ref.update(chats, (all) => new Map(all).set(id, json)),
      });
    }),
  );
}
