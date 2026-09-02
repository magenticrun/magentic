import { Conversation } from "@magentic/protocol";
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";

export class ConversationStoreError extends Schema.TaggedError<ConversationStoreError>()(
  "ConversationStoreError",
  { id: Schema.String, message: Schema.String },
) {}

/** Newest activity first. */
const byRecency = (a: Conversation, b: Conversation) =>
  DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt);

/**
 * Where conversations live between runs: what each one is, and its chat
 * history. The history is `Chat.exportJson` output, opaque to us, so it
 * survives model provider changes.
 */
export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    get(id: string): Effect.Effect<Option.Option<Conversation>>;
    /** The chat history, when the conversation has one. */
    history(id: string): Effect.Effect<Option.Option<string>>;
    /** Every conversation, newest activity first. */
    readonly list: Effect.Effect<ReadonlyArray<Conversation>>;
    save(info: Conversation, chatJson: string): Effect.Effect<void, ConversationStoreError>;
    /** What the conversation is, leaving its history as it was. */
    update(info: Conversation): Effect.Effect<void, ConversationStoreError>;
    /** Nothing to do when there is none. */
    remove(id: string): Effect.Effect<void, ConversationStoreError>;
  }
>()("magentic/core/ConversationStore") {
  /** Lost on restart. Fine for tests. */
  static readonly layerMemory = Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const infos = yield* Ref.make(new Map<string, Conversation>());
      const chats = yield* Ref.make(new Map<string, string>());
      return ConversationStore.of({
        get: (id) => Effect.map(Ref.get(infos), (all) => Option.fromNullishOr(all.get(id))),
        history: (id) => Effect.map(Ref.get(chats), (all) => Option.fromNullishOr(all.get(id))),
        list: Effect.map(Ref.get(infos), (all) => [...all.values()].toSorted(byRecency)),
        save: (info, json) =>
          Effect.andThen(
            Ref.update(infos, (all) => new Map(all).set(info.id, info)),
            Ref.update(chats, (all) => new Map(all).set(info.id, json)),
          ),
        update: (info) => Ref.update(infos, (all) => new Map(all).set(info.id, info)),
        remove: (id) =>
          Effect.andThen(
            Ref.update(infos, (all) => {
              const next = new Map(all);
              next.delete(id);
              return next;
            }),
            Ref.update(chats, (all) => {
              const next = new Map(all);
              next.delete(id);
              return next;
            }),
          ),
      });
    }),
  );

  /**
   * One directory per conversation under `dir`: `conversation.json` says what
   * it is, `history.json` is the chat as exported. A directory that cannot be
   * read is skipped from listings rather than failing them.
   */
  static readonly layerFile = (dir: string) =>
    Layer.effect(
      ConversationStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const InfoJson = Schema.fromJsonString(Conversation);
        const decodeInfo = Schema.decodeEffect(InfoJson);
        const encodeInfo = Schema.encodeEffect(InfoJson);
        const infoFile = (id: string) => path.join(dir, id, "conversation.json");
        const historyFile = (id: string) => path.join(dir, id, "history.json");

        const readIfExists = Effect.fn("ConversationStore.readIfExists")(function* (file: string) {
          if (!(yield* fs.exists(file))) {
            return Option.none<string>();
          }
          return Option.some(yield* fs.readFileString(file));
        });

        const get = Effect.fn("ConversationStore.get")(
          function* (id: string) {
            const text = yield* readIfExists(infoFile(id));
            if (Option.isNone(text)) {
              return Option.none<Conversation>();
            }
            return Option.some(yield* decodeInfo(text.value));
          },
          Effect.orElseSucceed(() => Option.none<Conversation>()),
        );

        const list = Effect.gen(function* () {
          if (!(yield* fs.exists(dir))) {
            return [];
          }
          const entries = yield* fs.readDirectory(dir);
          const found = yield* Effect.forEach(entries, get);
          return found
            .flatMap((info) => (Option.isSome(info) ? [info.value] : []))
            .toSorted(byRecency);
        }).pipe(Effect.orElseSucceed((): ReadonlyArray<Conversation> => []));

        const save = Effect.fn("ConversationStore.save")(
          function* (info: Conversation, json: string) {
            yield* fs.makeDirectory(path.join(dir, info.id), { recursive: true });
            yield* fs.writeFileString(historyFile(info.id), json);
            yield* fs.writeFileString(infoFile(info.id), yield* encodeInfo(info));
          },
          (effect, info) =>
            Effect.mapError(
              effect,
              (error) => new ConversationStoreError({ id: info.id, message: error.message }),
            ),
        );

        const update = Effect.fn("ConversationStore.update")(
          function* (info: Conversation) {
            yield* fs.makeDirectory(path.join(dir, info.id), { recursive: true });
            yield* fs.writeFileString(infoFile(info.id), yield* encodeInfo(info));
          },
          (effect, info) =>
            Effect.mapError(
              effect,
              (error) => new ConversationStoreError({ id: info.id, message: error.message }),
            ),
        );

        const remove = Effect.fn("ConversationStore.remove")(
          function* (id: string) {
            const target = path.join(dir, id);
            if (yield* fs.exists(target)) {
              yield* fs.remove(target, { recursive: true });
            }
          },
          (effect, id) =>
            Effect.mapError(
              effect,
              (error) => new ConversationStoreError({ id, message: error.message }),
            ),
        );

        return ConversationStore.of({
          get,
          history: (id) =>
            readIfExists(historyFile(id)).pipe(Effect.orElseSucceed(() => Option.none<string>())),
          list,
          save,
          update,
          remove,
        });
      }),
    );
}
