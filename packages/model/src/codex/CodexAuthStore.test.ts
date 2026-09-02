import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";
import { CodexAuthStore, readCodexCliAuth } from "./CodexAuthStore.ts";
import { fakeJwt, fakeTokens } from "./testing.ts";

layer(BunServices.layer)("codex auth store", (it) => {
  it.effect("round-trips tokens through a 0600 file and clears it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-codex-" });
      const file = path.join(dir, "nested", "codex-auth.json");
      const tokens = yield* fakeTokens({ expiresInSeconds: 100 });

      yield* Effect.gen(function* () {
        const store = yield* CodexAuthStore;
        assert.deepStrictEqual(yield* store.load, Option.none());
        yield* store.save(tokens);
        const loaded = yield* store.load;
        assert.deepStrictEqual(
          Option.map(loaded, (t) => t.accessToken),
          Option.some(tokens.accessToken),
        );
        const info = yield* fs.stat(file);
        assert.strictEqual(info.mode & 0o777, 0o600);
        // The directory it made is private too, and a loosened file is closed on the next save.
        assert.strictEqual((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
        yield* fs.chmod(file, 0o644);
        yield* store.save(tokens);
        assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
        yield* store.clear;
        assert.deepStrictEqual(yield* store.load, Option.none());
        assert.isFalse(yield* fs.exists(file));
      }).pipe(Effect.provide(CodexAuthStore.layerFile(file)));
    }).pipe(Effect.scoped),
  );

  it.effect("imports a Codex CLI auth.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-codex-" });
      const file = path.join(dir, "auth.json");
      const idToken = fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_cli" },
      });
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { id_token: idToken, access_token: "a", refresh_token: "r", account_id: null },
          last_refresh: "2026-08-27T11:34:25.679144Z",
        }),
      );
      const tokens = yield* readCodexCliAuth(file);
      assert.strictEqual(tokens.accountId, "acct_cli");
      assert.strictEqual(tokens.refreshToken, "r");
    }).pipe(Effect.scoped),
  );
});
