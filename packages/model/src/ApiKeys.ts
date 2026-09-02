import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
} from "effect";

/** Providers that authenticate with a plain API key. */
export const ApiKeyProvider = Schema.Literals(["openai", "anthropic", "zai", "opencode-zen"]);
export type ApiKeyProvider = typeof ApiKeyProvider.Type;

export class ApiKeyStoreError extends Schema.TaggedError<ApiKeyStoreError>()("ApiKeyStoreError", {
  message: Schema.String,
}) {}

const StoredFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    keys: Schema.Array(Schema.Struct({ provider: ApiKeyProvider, key: Schema.String })),
  }),
);

type Keys = ReadonlyMap<ApiKeyProvider, Redacted.Redacted<string>>;

const storage = (message: string) => new ApiKeyStoreError({ message });

/** Where the gateway and the CLI keep API keys. Never inside the config directory. */
export const apiKeysFile = Config.string("MAGENTIC_API_KEYS_FILE").pipe(
  Config.orElse(() =>
    Config.map(Config.string("HOME"), (home) => `${home}/.config/magentic/api-keys.json`),
  ),
);

/** A few characters of a key, enough to recognise it in `magentic auth status`. */
export const apiKeyHint = (key: Redacted.Redacted<string>): string => {
  const value = Redacted.value(key);
  return value.length <= 8 ? "****" : `${value.slice(0, 3)}…${value.slice(-4)}`;
};

/** API keys for the providers that use one, keyed by provider. */
export class ApiKeyStore extends Context.Service<
  ApiKeyStore,
  {
    get(
      provider: ApiKeyProvider,
    ): Effect.Effect<Option.Option<Redacted.Redacted<string>>, ApiKeyStoreError>;
    set(
      provider: ApiKeyProvider,
      key: Redacted.Redacted<string>,
    ): Effect.Effect<void, ApiKeyStoreError>;
    remove(provider: ApiKeyProvider): Effect.Effect<void, ApiKeyStoreError>;
    readonly list: Effect.Effect<ReadonlyArray<ApiKeyProvider>, ApiKeyStoreError>;
  }
>()("magentic/model/ApiKeyStore") {
  /** Built from any load/save pair over the whole map. */
  private static readonly fromBackend = (
    load: Effect.Effect<Keys, ApiKeyStoreError>,
    save: (keys: Keys) => Effect.Effect<void, ApiKeyStoreError>,
  ) =>
    ApiKeyStore.of({
      get: (provider) => Effect.map(load, (keys) => Option.fromNullishOr(keys.get(provider))),
      set: (provider, key) =>
        Effect.flatMap(load, (keys) => save(new Map(keys).set(provider, key))),
      remove: (provider) =>
        Effect.flatMap(load, (keys) => {
          const next = new Map(keys);
          next.delete(provider);
          return save(next);
        }),
      list: Effect.map(load, (keys) => [...keys.keys()]),
    });

  /** Keys held in memory only. For tests. */
  static readonly layerMemory = (initial: Keys = new Map()) =>
    Layer.effect(
      ApiKeyStore,
      Effect.gen(function* () {
        const ref = yield* Ref.make<Keys>(initial);
        return ApiKeyStore.fromBackend(Ref.get(ref), (keys) => Ref.set(ref, keys));
      }),
    );

  /** A JSON file, mode 0600, created on first save. */
  static readonly layerFile = (file: string) =>
    Layer.effect(
      ApiKeyStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const load = Effect.gen(function* () {
          const exists = yield* fs.exists(file);
          if (!exists) {
            return new Map<ApiKeyProvider, Redacted.Redacted<string>>();
          }
          const text = yield* fs.readFileString(file);
          const stored = yield* Schema.decodeEffect(StoredFile)(text);
          return new Map(stored.keys.map((entry) => [entry.provider, Redacted.make(entry.key)]));
        }).pipe(Effect.mapError((error) => storage(`cannot read ${file}: ${error.message}`)));

        const save = Effect.fn("ApiKeyStore.save")(
          function* (keys: Keys) {
            // The directory is private too, and the mode is set again on every
            // save: `mode` only applies when the file is created.
            yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
            const text = yield* Schema.encodeEffect(StoredFile)({
              version: 1,
              keys: [...keys].map(([provider, key]) => ({ provider, key: Redacted.value(key) })),
            });
            yield* fs.writeFileString(file, text, { mode: 0o600 });
            yield* fs.chmod(file, 0o600);
          },
          Effect.mapError((error) => storage(`cannot write ${file}: ${error.message}`)),
        );

        return ApiKeyStore.fromBackend(load, save);
      }),
    );
}
