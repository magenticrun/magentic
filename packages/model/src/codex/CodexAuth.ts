import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  SynchronizedRef,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CODEX_CLIENT_ID, CODEX_ISSUER } from "./Constants.ts";
import { CodexAuthStore } from "./CodexAuthStore.ts";
import { accessTokenExpiry, accountIdOf, CodexAuthError, CodexTokens } from "./CodexTokens.ts";

/** Codex refreshes when the access token is this close to expiry. */
const REFRESH_WINDOW = Duration.minutes(5);
/** ...or, when the token has no `exp`, when the last refresh is this old. */
const REFRESH_INTERVAL = Duration.days(8);
/** Two 401s in flight must not both refresh; the second one reuses the first result. */
const REFRESH_DEDUPE = Duration.seconds(30);

const RefreshResponse = Schema.Struct({
  id_token: Schema.optionalKey(Schema.String),
  access_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
});

/** The token endpoint reports failures in two shapes. */
const RefreshErrorBody = Schema.Union([
  Schema.Struct({ error: Schema.Struct({ code: Schema.optionalKey(Schema.String) }) }),
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ code: Schema.String }),
]);

const PERMANENT_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

const errorCode = (body: typeof RefreshErrorBody.Type): string | undefined => {
  if ("code" in body) {
    return body.code;
  }
  return Predicate.isString(body.error) ? body.error : body.error.code;
};

/**
 * Holds the current ChatGPT tokens and keeps them fresh. Every backend request
 * asks `current` for a token; a 401 asks `refresh` and retries once.
 */
export class CodexAuth extends Context.Service<
  CodexAuth,
  {
    readonly current: Effect.Effect<CodexTokens, CodexAuthError>;
    readonly refresh: Effect.Effect<CodexTokens, CodexAuthError>;
    readonly logout: Effect.Effect<void, CodexAuthError>;
    login(tokens: CodexTokens): Effect.Effect<void, CodexAuthError>;
  }
>()("magentic/model/CodexAuth") {
  static readonly layer: Layer.Layer<
    CodexAuth,
    CodexAuthError,
    CodexAuthStore | HttpClient.HttpClient
  > = Layer.effect(
    CodexAuth,
    Effect.gen(function* () {
      const store = yield* CodexAuthStore;
      const http = yield* HttpClient.HttpClient;
      const state = yield* SynchronizedRef.make(yield* store.load);

      const transient = (message: string) => new CodexAuthError({ reason: "Transient", message });

      const classify = (status: number, text: string): CodexAuthError => {
        const code = Schema.decodeOption(Schema.fromJsonString(RefreshErrorBody))(text).pipe(
          Option.map(errorCode),
          Option.getOrUndefined,
        );
        const permanent =
          status === 401 ||
          (status === 400 && code === "invalid_grant") ||
          (code !== undefined && PERMANENT_CODES.has(code));
        if (!permanent) {
          return transient(`token refresh failed with status ${status}`);
        }
        return new CodexAuthError({
          reason: code === "refresh_token_reused" ? "RefreshRevoked" : "RefreshExpired",
          message: `token refresh rejected (${code ?? status}); log in again`,
        });
      };

      const refreshTokens = Effect.fn("CodexAuth.refreshTokens")(function* (tokens: CodexTokens) {
        const request = yield* HttpClientRequest.post(`${CODEX_ISSUER}/oauth/token`).pipe(
          HttpClientRequest.bodyJson({
            client_id: CODEX_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken,
          }),
          Effect.mapError((error) => transient(`cannot encode refresh request: ${error.message}`)),
        );
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((error) => transient(`token refresh failed: ${error.message}`)));
        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* classify(response.status, text);
        }
        const fresh = yield* HttpClientResponse.schemaBodyJson(RefreshResponse)(response).pipe(
          Effect.mapError((error) => transient(`unexpected refresh response: ${error.message}`)),
        );
        const idToken = fresh.id_token ?? tokens.idToken;
        const merged = new CodexTokens({
          idToken,
          accessToken: fresh.access_token ?? tokens.accessToken,
          refreshToken: fresh.refresh_token ?? tokens.refreshToken,
          accountId: fresh.id_token === undefined ? tokens.accountId : yield* accountIdOf(idToken),
          lastRefresh: yield* DateTime.now,
        });
        yield* store.save(merged);
        return merged;
      });

      const needsRefresh = Effect.fn("CodexAuth.needsRefresh")(function* (tokens: CodexTokens) {
        const now = yield* DateTime.now;
        const expiry = yield* accessTokenExpiry(tokens);
        return Option.match(expiry, {
          onNone: () =>
            Duration.isGreaterThan(DateTime.distance(tokens.lastRefresh, now), REFRESH_INTERVAL),
          onSome: (exp) =>
            Duration.isLessThanOrEqualTo(DateTime.distance(now, exp), REFRESH_WINDOW),
        });
      });

      const notLoggedIn = new CodexAuthError({
        reason: "NotLoggedIn",
        message: "no ChatGPT login; run `magentic auth login`",
      });

      const current = SynchronizedRef.modifyEffect(state, (loaded) =>
        Effect.gen(function* () {
          if (Option.isNone(loaded)) {
            return yield* notLoggedIn;
          }
          if (!(yield* needsRefresh(loaded.value))) {
            return [loaded.value, loaded] as const;
          }
          const fresh = yield* refreshTokens(loaded.value);
          return [fresh, Option.some(fresh)] as const;
        }),
      );

      const refresh = SynchronizedRef.modifyEffect(state, (loaded) =>
        Effect.gen(function* () {
          if (Option.isNone(loaded)) {
            return yield* notLoggedIn;
          }
          const now = yield* DateTime.now;
          const age = DateTime.distance(loaded.value.lastRefresh, now);
          if (Duration.isLessThan(age, REFRESH_DEDUPE)) {
            return [loaded.value, loaded] as const;
          }
          const fresh = yield* refreshTokens(loaded.value);
          return [fresh, Option.some(fresh)] as const;
        }),
      );

      const login = Effect.fn("CodexAuth.login")(function* (tokens: CodexTokens) {
        yield* store.save(tokens);
        yield* SynchronizedRef.set(state, Option.some(tokens));
      });

      const logout = Effect.gen(function* () {
        yield* store.clear;
        yield* SynchronizedRef.set(state, Option.none());
      });

      return CodexAuth.of({ current, refresh, login, logout });
    }),
  );
}
