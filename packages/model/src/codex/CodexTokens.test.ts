import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { accessTokenExpiry, accountIdOf, decodeJwtClaims, planTypeOf } from "./CodexTokens.ts";
import { fakeJwt, fakeTokens } from "./testing.ts";

describe("codex tokens", () => {
  it.effect("reads the account id and plan from the id token", () =>
    Effect.gen(function* () {
      const tokens = yield* fakeTokens({ expiresInSeconds: 3600, accountId: "acct_42" });
      assert.strictEqual(yield* accountIdOf(tokens.idToken), "acct_42");
      assert.deepStrictEqual(yield* planTypeOf(tokens.idToken), Option.some("plus"));
    }),
  );

  it.effect("reads the expiry from the access token", () =>
    Effect.gen(function* () {
      const tokens = yield* fakeTokens({ expiresInSeconds: 3600 });
      const expiry = yield* accessTokenExpiry(tokens);
      assert.isTrue(Option.isSome(expiry));
      const now = yield* DateTime.now;
      const seconds = Option.match(expiry, {
        onNone: () => 0,
        onSome: (exp) => (DateTime.toEpochMillis(exp) - DateTime.toEpochMillis(now)) / 1000,
      });
      assert.isTrue(seconds > 3590 && seconds <= 3600);
    }),
  );

  it.effect("has no expiry when the token carries none", () =>
    Effect.gen(function* () {
      const tokens = yield* fakeTokens({ expiresInSeconds: 1 });
      const bare = { ...tokens, accessToken: fakeJwt({ sub: "x" }) };
      assert.deepStrictEqual(yield* accessTokenExpiry(bare), Option.none());
    }),
  );

  it.effect("rejects tokens that are not JWTs", () =>
    Effect.gen(function* () {
      const error = yield* decodeJwtClaims("not-a-jwt").pipe(Effect.flip);
      assert.strictEqual(error.reason, "MalformedToken");
      const missing = yield* accountIdOf(fakeJwt({})).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "MalformedToken");
    }),
  );
});
