import { DateTime, Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CODEX_CLIENT_ID, CODEX_ISSUER } from "./Constants.ts";
import { accountIdOf, CodexAuthError, CodexTokens } from "./CodexTokens.ts";

/** What to show the person: where to go and what to type. */
export interface DeviceLoginPrompt {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

const UserCodeResponse = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.optionalKey(Schema.String),
  usercode: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
});

const CodeSuccessResponse = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
});

const TokenResponse = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
});

/** Codex adds a few seconds so it never polls faster than the server asked. */
const POLL_SAFETY_MARGIN = Duration.seconds(3);
const DEFAULT_TIMEOUT = Duration.minutes(15);

const loginFailed = (message: string) => new CodexAuthError({ reason: "LoginFailed", message });

const decodeJson = <S extends Schema.Constraint>(schema: S, what: string) =>
  Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((error) => loginFailed(`unexpected ${what} response: ${error.message}`)),
    );
  });

/**
 * The Codex CLI's headless login: ask for a user code, have the person enter
 * it in a browser anywhere, poll until they do, then exchange the code for tokens.
 * Works over SSH, which the browser flow does not.
 */
export const deviceLogin = Effect.fn("CodexLogin.deviceLogin")(function* (options: {
  readonly onPrompt: (prompt: DeviceLoginPrompt) => Effect.Effect<void>;
  readonly timeout?: Duration.Duration | undefined;
}) {
  const http = yield* HttpClient.HttpClient;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const post = Effect.fn("CodexLogin.post")(function* (url: string, body: Record<string, string>) {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError((error) => loginFailed(`cannot encode request: ${error.message}`)),
    );
    return yield* http
      .execute(request)
      .pipe(Effect.mapError((error) => loginFailed(`${url}: ${error.message}`)));
  });

  // Step 1: a user code.
  const started = yield* post(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    client_id: CODEX_CLIENT_ID,
  });
  if (started.status === 404) {
    return yield* loginFailed("device code login is not enabled for this account");
  }
  if (started.status < 200 || started.status >= 300) {
    return yield* loginFailed(`user code request failed with status ${started.status}`);
  }
  const userCodeBody = yield* decodeJson(UserCodeResponse, "user code")(started);
  const userCode = userCodeBody.user_code ?? userCodeBody.usercode;
  if (userCode === undefined) {
    return yield* loginFailed("user code response carried no code");
  }
  const intervalSeconds = Number(userCodeBody.interval ?? 5);
  const interval = Duration.sum(
    Duration.seconds(Number.isFinite(intervalSeconds) ? intervalSeconds : 5),
    POLL_SAFETY_MARGIN,
  );

  yield* options.onPrompt({
    verificationUrl: `${CODEX_ISSUER}/codex/device`,
    userCode,
    expiresIn: timeout,
  });

  // Step 2: poll until the person has entered the code.
  const deadline = DateTime.addDuration(yield* DateTime.now, timeout);
  const poll: Effect.Effect<typeof CodeSuccessResponse.Type, CodexAuthError> = Effect.gen(
    function* () {
      const response = yield* post(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
        device_auth_id: userCodeBody.device_auth_id,
        user_code: userCode,
      });
      if (response.status === 403 || response.status === 404) {
        const now = yield* DateTime.now;
        if (DateTime.isGreaterThan(now, deadline)) {
          return yield* new CodexAuthError({
            reason: "LoginTimedOut",
            message: "the code was not entered in time",
          });
        }
        yield* Effect.sleep(interval);
        return yield* poll;
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* loginFailed(`device authorization failed with status ${response.status}`);
      }
      return yield* decodeJson(CodeSuccessResponse, "device authorization")(response);
    },
  );
  const authorized = yield* poll;

  // Step 3: the ordinary code exchange, with the server-supplied verifier.
  const exchange = yield* HttpClientRequest.post(`${CODEX_ISSUER}/oauth/token`).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "authorization_code",
      code: authorized.authorization_code,
      redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: authorized.code_verifier,
    }),
    http.execute,
    Effect.mapError((error) => loginFailed(`token exchange failed: ${error.message}`)),
  );
  if (exchange.status < 200 || exchange.status >= 300) {
    return yield* loginFailed(`token exchange failed with status ${exchange.status}`);
  }
  const tokens = yield* decodeJson(TokenResponse, "token")(exchange);
  return new CodexTokens({
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: yield* accountIdOf(tokens.id_token),
    lastRefresh: yield* DateTime.now,
  });
});
