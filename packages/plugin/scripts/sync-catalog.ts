/**
 * Refreshes the bundled models.dev snapshot: `bun run catalog:sync` from
 * packages/plugin. Keeps only the providers we ship plugins for, and only the
 * fields the catalog schema reads, so the snapshot stays small.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { CatalogProvider } from "../src/Catalog.ts";

const SOURCE = "https://models.dev/api.json";
const PROVIDERS = ["openai", "anthropic", "zai", "opencode"] as const;

const Feed = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const Snapshot = Schema.Record(Schema.String, CatalogProvider);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const text = yield* Effect.flatMap(http.get(SOURCE), (response) => response.text);
  const feed = yield* Schema.decodeEffect(Feed)(text);

  const snapshot: Record<string, CatalogProvider> = {};
  for (const id of PROVIDERS) {
    const entry = feed[id];
    if (entry === undefined) {
      return yield* Effect.fail(new Error(`${SOURCE} has no provider "${id}"`));
    }
    const provider = yield* Schema.decodeUnknownEffect(CatalogProvider)(entry);
    const models = Object.fromEntries(
      Object.keys(provider.models)
        .toSorted()
        .map((modelId) => [modelId, provider.models[modelId]]),
    );
    snapshot[id] = new CatalogProvider({ ...provider, models });
  }

  const encoded = yield* Schema.encodeEffect(Snapshot)(snapshot);
  const target = new URL("../src/catalog/snapshot.json", import.meta.url).pathname;
  yield* fs.writeFileString(target, `${JSON.stringify(encoded, null, 2)}\n`);
  const counts = PROVIDERS.map((id) => `${id}=${Object.keys(snapshot[id]?.models ?? {}).length}`);
  yield* Effect.log(`wrote ${target}: ${counts.join(", ")}`);
});

BunRuntime.runMain(program.pipe(Effect.provide([BunServices.layer, FetchHttpClient.layer])));
