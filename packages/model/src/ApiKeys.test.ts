import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import { apiKeyHint, ApiKeyStore } from "./ApiKeys.ts";

layer(BunServices.layer)("api key store", (it) => {
  it.effect("round-trips keys through a 0600 file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-keys-" });
      const file = path.join(dir, "nested", "api-keys.json");

      yield* Effect.gen(function* () {
        const store = yield* ApiKeyStore;
        assert.deepStrictEqual(yield* store.list, []);
        yield* store.set("anthropic", Redacted.make("sk-ant-secret-1234"));
        yield* store.set("openai", Redacted.make("sk-openai-secret-5678"));
        const info = yield* fs.stat(file);
        assert.strictEqual(info.mode & 0o777, 0o600);
        assert.deepStrictEqual(yield* store.list, ["anthropic", "openai"]);
        const loaded = yield* store.get("anthropic");
        assert.deepStrictEqual(
          Option.map(loaded, Redacted.value),
          Option.some("sk-ant-secret-1234"),
        );
        yield* store.remove("anthropic");
        assert.deepStrictEqual(yield* store.get("anthropic"), Option.none());
        assert.deepStrictEqual(yield* store.list, ["openai"]);
      }).pipe(Effect.provide(ApiKeyStore.layerFile(file)));
    }).pipe(Effect.scoped),
  );

  it.effect("hints never reveal short keys", () =>
    Effect.sync(() => {
      assert.strictEqual(apiKeyHint(Redacted.make("short")), "****");
      assert.strictEqual(apiKeyHint(Redacted.make("sk-ant-secret-1234")), "sk-…1234");
    }),
  );
});
