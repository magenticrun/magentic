import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { fakeProviderPlugin } from "@magentic/model";
import { ModelCatalog } from "@magentic/plugin";
import { Effect, Layer, Option, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ModelRegistry } from "./ModelRegistry.ts";
import { builtin, PluginHost } from "./PluginHost.ts";
import { ToolCallGuard } from "./ToolRegistry.ts";

const HostLayer = PluginHost.layer({
  plugins: [builtin(fakeProviderPlugin(() => [{ type: "text", text: "ok" }]))],
  paths: { config: "/nonexistent/magentic", workspace: "/nonexistent" },
}).pipe(
  Layer.provide(ToolCallGuard.layerAllowAll),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

const failure = (ref: Option.Option<string>) =>
  Effect.flatMap(ModelRegistry, (registry) =>
    Effect.map(Effect.result(registry.languageModel(ref)), (outcome) =>
      Result.isFailure(outcome) ? outcome.failure.message : "",
    ),
  );

layer(HostLayer)("ModelRegistry", (it) => {
  it.effect("resolves no reference, a provider, and a provider/model to the same model", () =>
    Effect.gen(function* () {
      const registry = yield* ModelRegistry;
      const byDefault = yield* registry.languageModel(Option.none());
      const byProvider = yield* registry.languageModel(Option.some("fake"));
      const byRef = yield* registry.languageModel(Option.some("fake/fake"));
      assert.strictEqual(byProvider, byDefault);
      assert.strictEqual(byRef, byDefault);
    }),
  );

  it.effect("says where a reference lands without building the model", () =>
    Effect.gen(function* () {
      const registry = yield* ModelRegistry;
      const refs = yield* Effect.forEach(
        [Option.none(), Option.some("fake"), Option.some("fake/fake")],
        (ref) => Effect.map(registry.resolve(ref), (resolved) => resolved.ref),
      );
      assert.deepStrictEqual(refs, ["fake/fake", "fake/fake", "fake/fake"]);
    }),
  );

  it.effect("names the provider's models when the model is unknown", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* failure(Option.some("fake/nope")),
        'fake has no model "nope"; known: fake',
      );
    }),
  );

  it.effect("names the providers when the provider is unknown", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* failure(Option.some("nope/whatever")),
        'no model provider with id "nope"; known: fake',
      );
    }),
  );
});
