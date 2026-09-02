import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { CodexAuth } from "./CodexAuth.ts";
import { withCodexAuth } from "./CodexClient.ts";
import { fakeHttp, fakeTokens } from "./testing.ts";

/** An auth whose refresh swaps in a second token, counting how often it ran. */
const fakeAuth = Effect.gen(function* () {
  const before = yield* fakeTokens({ expiresInSeconds: 3600, accountId: "acct_before" });
  const after = yield* fakeTokens({ expiresInSeconds: 3600, accountId: "acct_after" });
  const state = yield* Ref.make(before);
  const refreshes = yield* Ref.make(0);
  const auth = CodexAuth.of({
    current: Ref.get(state),
    refresh: Ref.update(refreshes, (n) => n + 1).pipe(
      Effect.andThen(Ref.set(state, after)),
      Effect.as(after),
    ),
    login: () => Effect.void,
    logout: Effect.void,
  });
  return { auth, before, after, refreshes: Ref.get(refreshes) };
});

describe("codex client", () => {
  it.effect("sends the bearer token and account headers", () =>
    Effect.gen(function* () {
      const { auth, before } = yield* fakeAuth;
      const http = yield* fakeHttp([{ status: 200, body: "{}" }]);
      const codex = yield* Effect.map(HttpClient.HttpClient, (base) =>
        base.pipe(HttpClient.filterStatusOk, withCodexAuth(auth, "session-1")),
      ).pipe(Effect.provide(http.layer));
      yield* codex.execute(HttpClientRequest.get("https://chatgpt.com/backend-api/codex/models"));
      const [request] = yield* http.requests;
      assert.strictEqual(request?.headers["authorization"], `Bearer ${before.accessToken}`);
      assert.strictEqual(request?.headers["chatgpt-account-id"], "acct_before");
      assert.strictEqual(request?.headers["originator"], "magentic");
      assert.strictEqual(request?.headers["session-id"], "session-1");
    }),
  );

  it.effect("refreshes once and retries on a 401", () =>
    Effect.gen(function* () {
      const { auth, after, refreshes } = yield* fakeAuth;
      const http = yield* fakeHttp([{ status: 401 }, { status: 200, body: "{}" }]);
      const codex = yield* Effect.map(HttpClient.HttpClient, (base) =>
        base.pipe(HttpClient.filterStatusOk, withCodexAuth(auth, "s")),
      ).pipe(Effect.provide(http.layer));
      const response = yield* codex.execute(HttpClientRequest.get("https://x/responses"));
      assert.strictEqual(response.status, 200);
      const requests = yield* http.requests;
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[1]?.headers["authorization"], `Bearer ${after.accessToken}`);
      assert.strictEqual(requests[1]?.headers["chatgpt-account-id"], "acct_after");
      assert.strictEqual(yield* refreshes, 1);
    }),
  );

  it.effect("does not refresh or retry on other failures", () =>
    Effect.gen(function* () {
      const { auth, refreshes } = yield* fakeAuth;
      const http = yield* fakeHttp([{ status: 429, body: "{}" }]);
      const codex = yield* Effect.map(HttpClient.HttpClient, (base) =>
        base.pipe(HttpClient.filterStatusOk, withCodexAuth(auth, "s")),
      ).pipe(Effect.provide(http.layer));
      const error = yield* codex
        .execute(HttpClientRequest.get("https://x/responses"))
        .pipe(Effect.flip);
      assert.strictEqual(error.reason._tag, "StatusCodeError");
      assert.strictEqual((yield* http.requests).length, 1);
      assert.strictEqual(yield* refreshes, 0);
    }),
  );
});
