import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CodexAuth } from "./CodexAuth.ts";
import { CodexAuthStore } from "./CodexAuthStore.ts";
import { fakeHttp, fakeJwt, fakeTokens } from "./testing.ts";

const freshAccess = fakeJwt({ exp: 4102444800 }); // year 2100

describe("codex auth", () => {
  it.effect("fails clearly when nobody has logged in", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([]);
      const error = yield* Effect.flatMap(CodexAuth, (auth) => auth.current).pipe(
        Effect.provide(
          CodexAuth.layer.pipe(Layer.provide([CodexAuthStore.layerMemory(), http.layer])),
        ),
        Effect.flip,
      );
      assert.strictEqual(error.reason, "NotLoggedIn");
      assert.deepStrictEqual(yield* http.requests, []);
    }),
  );

  it.effect("hands out the stored token while it is fresh", () =>
    Effect.gen(function* () {
      const tokens = yield* fakeTokens({ expiresInSeconds: 3600 });
      const http = yield* fakeHttp([]);
      const current = yield* Effect.flatMap(CodexAuth, (auth) => auth.current).pipe(
        Effect.provide(
          CodexAuth.layer.pipe(Layer.provide([CodexAuthStore.layerMemory(tokens), http.layer])),
        ),
      );
      assert.strictEqual(current.accessToken, tokens.accessToken);
      assert.deepStrictEqual(yield* http.requests, []);
    }),
  );

  it.effect("refreshes once when the token is about to expire, and persists the result", () =>
    Effect.gen(function* () {
      const tokens = yield* fakeTokens({ expiresInSeconds: 60, refreshToken: "refresh_old" });
      const http = yield* fakeHttp([
        {
          status: 200,
          body: JSON.stringify({ access_token: freshAccess, refresh_token: "refresh_new" }),
        },
      ]);
      const Store = CodexAuthStore.layerMemory(tokens);
      const program = Effect.gen(function* () {
        const auth = yield* CodexAuth;
        const first = yield* auth.current;
        const second = yield* auth.current;
        const stored = yield* Effect.flatMap(CodexAuthStore, (store) => store.load);
        return { first, second, stored };
      });
      const { first, second, stored } = yield* program.pipe(
        Effect.provide(CodexAuth.layer.pipe(Layer.provideMerge(Store), Layer.provide(http.layer))),
      );

      const requests = yield* http.requests;
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, "https://auth.openai.com/oauth/token");
      assert.deepStrictEqual(JSON.parse(requests[0]?.body ?? "{}"), {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "refresh_old",
      });
      assert.strictEqual(first.accessToken, freshAccess);
      assert.strictEqual(first.refreshToken, "refresh_new");
      assert.strictEqual(first.accountId, tokens.accountId);
      assert.strictEqual(second.accessToken, freshAccess);
      assert.deepStrictEqual(
        Option.map(stored, (t) => t.refreshToken),
        Option.some("refresh_new"),
      );
    }),
  );

  it.effect("classifies refresh failures the way the Codex CLI does", () =>
    Effect.gen(function* () {
      const cases = [
        { status: 401, body: "", reason: "RefreshExpired" },
        { status: 400, body: JSON.stringify({ error: "invalid_grant" }), reason: "RefreshExpired" },
        {
          status: 400,
          body: JSON.stringify({ error: { code: "refresh_token_reused" } }),
          reason: "RefreshRevoked",
        },
        { status: 500, body: "oops", reason: "Transient" },
      ] as const;
      for (const c of cases) {
        const tokens = yield* fakeTokens({ expiresInSeconds: 10 });
        const http = yield* fakeHttp([{ status: c.status, body: c.body }]);
        const error = yield* Effect.flatMap(CodexAuth, (auth) => auth.current).pipe(
          Effect.provide(
            CodexAuth.layer.pipe(Layer.provide([CodexAuthStore.layerMemory(tokens), http.layer])),
          ),
          Effect.flip,
        );
        assert.strictEqual(error.reason, c.reason, `status ${c.status}`);
      }
    }),
  );
});
