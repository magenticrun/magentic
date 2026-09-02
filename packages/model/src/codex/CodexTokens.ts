import { DateTime, Effect, Encoding, Option, Result, Schema } from "effect";

export class CodexAuthError extends Schema.TaggedError<CodexAuthError>()("CodexAuthError", {
  reason: Schema.Literals([
    "NotLoggedIn",
    "RefreshExpired",
    "RefreshRevoked",
    "Transient",
    "MalformedToken",
    "Storage",
    "LoginFailed",
    "LoginTimedOut",
  ]),
  message: Schema.String,
}) {}

/** What a ChatGPT login leaves us with. `accountId` is what the backend routes on. */
export class CodexTokens extends Schema.Class<CodexTokens>("magentic/model/CodexTokens")({
  idToken: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  accountId: Schema.String,
  lastRefresh: Schema.DateTimeUtcFromString,
}) {}

/** OpenAI namespaces its custom claims under this key in both the id and access tokens. */
export const AUTH_CLAIMS = "https://api.openai.com/auth";

export const JwtClaims = Schema.Struct({
  exp: Schema.optionalKey(Schema.Number),
  [AUTH_CLAIMS]: Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
      chatgpt_plan_type: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type JwtClaims = typeof JwtClaims.Type;

const malformed = (message: string) => new CodexAuthError({ reason: "MalformedToken", message });

/** Reads the payload of a JWT without verifying it, as the Codex CLI does. */
export const decodeJwtClaims = Effect.fn("CodexTokens.decodeJwtClaims")(function* (token: string) {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return yield* malformed("token is not a JWT");
  }
  const json = Encoding.decodeBase64UrlString(payload);
  if (Result.isFailure(json)) {
    return yield* malformed("JWT payload is not base64url");
  }
  return yield* Schema.decodeEffect(Schema.fromJsonString(JwtClaims))(json.success).pipe(
    Effect.mapError((error) => malformed(`JWT payload is not valid: ${error.message}`)),
  );
});

/** When the access token stops working, if the token says. */
export const accessTokenExpiry = (tokens: CodexTokens) =>
  decodeJwtClaims(tokens.accessToken).pipe(
    Effect.map((claims) =>
      claims.exp === undefined
        ? Option.none<DateTime.Utc>()
        : Option.some(DateTime.makeUnsafe(claims.exp * 1000)),
    ),
  );

export const accountIdOf = Effect.fn("CodexTokens.accountIdOf")(function* (idToken: string) {
  const claims = yield* decodeJwtClaims(idToken);
  const accountId = claims[AUTH_CLAIMS]?.chatgpt_account_id;
  if (accountId === undefined) {
    return yield* malformed("id token carries no chatgpt_account_id");
  }
  return accountId;
});

export const planTypeOf = (idToken: string) =>
  decodeJwtClaims(idToken).pipe(
    Effect.map((claims) => Option.fromNullishOr(claims[AUTH_CLAIMS]?.chatgpt_plan_type)),
  );
