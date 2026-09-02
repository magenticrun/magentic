import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ModelCatalog } from "./Catalog.ts";

/** A models.dev feed with one provider that decodes, one that does not, and stray fields. */
const feed = JSON.stringify({
  acme: {
    id: "acme",
    name: "Acme",
    npm: "@ai-sdk/openai-compatible",
    api: "https://acme.example/v1",
    env: ["ACME_API_KEY"],
    extra: "ignored",
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        reasoning: true,
        tool_call: true,
        limit: { context: 8000, output: 1000 },
        cost: { input: 1, output: 2 },
        provider: { npm: "@ai-sdk/anthropic" },
      },
    },
  },
  broken: { id: "broken" },
});

const Http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(feed, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    ),
  ),
);

/** The live layer with its cache in a scoped temp directory, so nothing touches ~/.cache. */
const live = (offline: boolean) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-models-" });
      return ModelCatalog.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              MAGENTIC_MODELS_CACHE: `${dir}/models.json`,
              MAGENTIC_MODELS_URL: "https://models.example/api.json",
              MAGENTIC_MODELS_OFFLINE: offline ? "true" : "false",
            }),
          ),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, Http)));

layer(ModelCatalog.layerSnapshot)("ModelCatalog.layerSnapshot", (it) => {
  it.effect("ships the providers we have plugins for", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      const all = yield* catalog.all;
      assert.deepStrictEqual([...all.keys()].toSorted(), [
        "anthropic",
        "openai",
        "opencode",
        "zai",
      ]);
      const zen = Option.getOrThrow(yield* catalog.provider("opencode"));
      assert.strictEqual(zen.models["claude-sonnet-5"]?.provider?.npm, "@ai-sdk/anthropic");
      assert.isTrue(Option.isNone(yield* catalog.provider("nope")));
    }),
  );
});

layer(live(true))("ModelCatalog.layer offline", (it) => {
  it.effect("serves the snapshot and never fetches", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      yield* catalog.refresh;
      assert.isTrue((yield* catalog.all).has("openai"));
      assert.isFalse((yield* catalog.all).has("acme"));
    }),
  );
});

layer(live(false))("ModelCatalog.layer online", (it) => {
  it.effect("decodes the feed one provider at a time and keeps what decodes", () =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      yield* catalog.refresh;
      const all = yield* catalog.all;
      assert.deepStrictEqual([...all.keys()], ["acme"]);
      const acme = Option.getOrThrow(yield* catalog.provider("acme"));
      assert.strictEqual(acme.models["acme-1"]?.limit?.context, 8000);
      assert.strictEqual(acme.models["acme-1"]?.provider?.npm, "@ai-sdk/anthropic");
    }),
  );
});
