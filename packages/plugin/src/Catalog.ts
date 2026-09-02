import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import snapshot from "./catalog/snapshot.json" with { type: "json" };

/**
 * models.dev's shape, trimmed to what provider plugins read. Field names are
 * theirs so the live feed and the bundled snapshot decode the same way.
 */
export class CatalogModel extends Schema.Class<CatalogModel>("magentic/plugin/CatalogModel")({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  attachment: Schema.optional(Schema.Boolean),
  /** "alpha", "beta", or "deprecated"; absent means generally available. */
  status: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Struct({ context: Schema.Number, output: Schema.optional(Schema.Number) }),
  ),
  /** The protocol (an AI SDK package name) and base URL when they differ from the provider's. */
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
}) {}

export class CatalogProvider extends Schema.Class<CatalogProvider>(
  "magentic/plugin/CatalogProvider",
)({
  id: Schema.String,
  name: Schema.String,
  api: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.Record(Schema.String, CatalogModel),
}) {}

/** Providers keyed by models.dev id ("opencode", "zai", ...). */
export type Catalog = ReadonlyMap<string, CatalogProvider>;

/** A feed's providers, each decoded the first time it is asked for. */
interface Feed {
  readonly provider: (id: string) => Effect.Effect<Option.Option<CatalogProvider>>;
  readonly all: Effect.Effect<Catalog>;
}

export class CatalogError extends Schema.TaggedError<CatalogError>()("CatalogError", {
  message: Schema.String,
}) {}

const Entries = Schema.Record(Schema.String, Schema.Unknown);

/**
 * The feed with each provider decoded when first asked for, and then kept.
 * models.dev lists a couple of hundred providers and a chat reads three or
 * four; decoding them all up front costs more than everything else a chat
 * does before its first paint. A provider that fails to decode is skipped
 * with a warning and hides only itself.
 */
const feed = Effect.fn("ModelCatalog.feed")(function* (input: Schema.Json) {
  const entries = yield* Schema.decodeUnknownEffect(Entries)(input).pipe(
    Effect.mapError((error) => new CatalogError({ message: error.message })),
  );
  const decoded = new Map<string, Option.Option<CatalogProvider>>();
  const provider = Effect.fnUntraced(function* (id: string) {
    const known = decoded.get(id);
    if (known !== undefined) {
      return known;
    }
    if (!Object.hasOwn(entries, id)) {
      return Option.none<CatalogProvider>();
    }
    const result = yield* Effect.result(Schema.decodeUnknownEffect(CatalogProvider)(entries[id]));
    if (Result.isFailure(result)) {
      yield* Effect.logWarning(
        `models catalog: skipping provider "${id}": ${result.failure.message}`,
      );
    }
    const found = Result.match(result, {
      onFailure: () => Option.none<CatalogProvider>(),
      onSuccess: Option.some,
    });
    decoded.set(id, found);
    return found;
  });
  const all = Effect.gen(function* () {
    const catalog = new Map<string, CatalogProvider>();
    for (const id of Object.keys(entries)) {
      const found = yield* provider(id);
      if (Option.isSome(found)) {
        catalog.set(id, found.value);
      }
    }
    return catalog;
  });
  return { provider, all } satisfies Feed;
});

const parseJson = (text: string) =>
  Effect.try({
    try: (): Schema.Json => JSON.parse(text),
    catch: (error) =>
      new CatalogError({ message: error instanceof Error ? error.message : String(error) }),
  });

/** Where the live catalog comes from. */
export const modelsUrl = Config.string("MAGENTIC_MODELS_URL").pipe(
  Config.withDefault("https://models.dev/api.json"),
);

/** The on-disk copy of the last fetch. Shared by the gateway and the CLI. */
export const modelsCacheFile = Config.string("MAGENTIC_MODELS_CACHE").pipe(
  Config.orElse(() =>
    Config.map(Config.string("HOME"), (home) => `${home}/.cache/magentic/models.json`),
  ),
);

/** Never fetch; use the cache if present, else the bundled snapshot. */
export const modelsOffline = Config.schema(Config.Boolean, "MAGENTIC_MODELS_OFFLINE").pipe(
  Config.withDefault(false),
);

const CACHE_TTL = Duration.minutes(60);

/**
 * What models each provider offers, from models.dev. Provider plugins read it
 * to list their models and to learn which protocol and base URL each one
 * speaks. Ships with a snapshot so nothing depends on the network.
 */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly all: Effect.Effect<Catalog>;
    provider(id: string): Effect.Effect<Option.Option<CatalogProvider>>;
    /** Fetch now, whatever the cache's age. Failures are logged, never raised. */
    readonly refresh: Effect.Effect<void>;
  }
>()("magentic/plugin/ModelCatalog") {
  /** The snapshot cannot fail to be a record; it is checked in. */
  private static readonly bundled = feed(snapshot).pipe(Effect.orDie);

  private static readonly over = (source: Effect.Effect<Feed>, refresh: Effect.Effect<void>) =>
    ModelCatalog.of({
      all: Effect.flatMap(source, (found) => found.all),
      provider: (id) => Effect.flatMap(source, (found) => found.provider(id)),
      refresh,
    });

  /** The bundled snapshot only. For tests and for hosts that must not touch the network. */
  static readonly layerSnapshot = Layer.effect(
    ModelCatalog,
    Effect.map(ModelCatalog.bundled, (bundled) =>
      ModelCatalog.over(Effect.succeed(bundled), Effect.void),
    ),
  );

  /**
   * The cache file when it exists, else the snapshot; refreshed from models.dev
   * in the background once an hour unless `MAGENTIC_MODELS_OFFLINE` is set.
   */
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({
          times: 2,
          schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
        }),
      );
      const url = yield* modelsUrl;
      const file = yield* modelsCacheFile;
      const offline = yield* modelsOffline;
      const current = yield* Ref.make(Option.none<Feed>());
      const lock = yield* Semaphore.make(1);

      const readCache = Effect.gen(function* () {
        if (!(yield* fs.exists(file))) {
          return Option.none<Feed>();
        }
        const text = yield* fs.readFileString(file);
        return Option.some(yield* feed(yield* parseJson(text)));
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`models catalog: ignoring ${file}: ${error.message}`).pipe(
            Effect.as(Option.none<Feed>()),
          ),
        ),
      );

      /** The cache file the first time, read once; the snapshot when there is none. */
      const source = lock.withPermit(
        Effect.gen(function* () {
          const loaded = yield* Ref.get(current);
          if (Option.isSome(loaded)) {
            return loaded.value;
          }
          const cached = yield* readCache;
          const found = Option.isSome(cached) ? cached.value : yield* ModelCatalog.bundled;
          yield* Ref.set(current, Option.some(found));
          return found;
        }),
      );

      const fresh = Effect.gen(function* () {
        const stat = yield* fs.stat(file);
        const now = yield* Clock.currentTimeMillis;
        return Option.match(stat.mtime, {
          onNone: () => false,
          onSome: (mtime) => now - mtime.getTime() < Duration.toMillis(CACHE_TTL),
        });
      }).pipe(Effect.catch(() => Effect.succeed(false)));

      const fetchAndStore = Effect.gen(function* () {
        const text = yield* HttpClientRequest.get(url).pipe(
          http.execute,
          Effect.flatMap((response) => response.text),
          Effect.timeout("10 seconds"),
        );
        const fetched = yield* feed(yield* parseJson(text));
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, text);
        yield* Ref.set(current, Option.some(fetched));
      });

      const refresh = lock
        .withPermit(fetchAndStore)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`models catalog: refresh from ${url} failed: ${error.message}`),
          ),
        );

      if (!offline) {
        yield* Effect.gen(function* () {
          if (!(yield* fresh)) {
            yield* refresh;
          }
        }).pipe(Effect.repeat(Schedule.spaced(CACHE_TTL)), Effect.forkScoped);
      }

      return ModelCatalog.over(source, offline ? Effect.void : refresh);
    }),
  );
}
