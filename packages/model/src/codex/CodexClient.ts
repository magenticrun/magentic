import type { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as Clients from "../Clients.ts";
import { CODEX_API_URL, CODEX_ORIGINATOR, CODEX_USER_AGENT } from "./Constants.ts";
import { CodexAuth } from "./CodexAuth.ts";
import { withStreamOnlyBackend } from "./CodexStreamShim.ts";

const isUnauthorized = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "StatusCodeError" && error.reason.response.status === 401;

/**
 * Turns any HttpClient into one that speaks to the Codex backend as the
 * logged-in ChatGPT account: bearer token and account header on every request,
 * one refresh-and-retry on a 401.
 */
export const withCodexAuth =
  (auth: CodexAuth["Service"], sessionId: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((request) =>
        auth.current.pipe(
          Effect.map((tokens) =>
            request.pipe(
              HttpClientRequest.bearerToken(tokens.accessToken),
              HttpClientRequest.setHeaders({
                "ChatGPT-Account-ID": tokens.accountId,
                originator: CODEX_ORIGINATOR,
                "User-Agent": CODEX_USER_AGENT,
                "session-id": sessionId,
              }),
            ),
          ),
          // Auth failures surface through the HTTP error channel the OpenAI client already handles.
          Effect.mapError(
            (error) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: error.message,
                  cause: error,
                }),
              }),
          ),
        ),
      ),
      HttpClient.transformResponse(
        Effect.tapError((error) =>
          isUnauthorized(error) ? auth.refresh.pipe(Effect.ignore) : Effect.void,
        ),
      ),
      HttpClient.retry({ times: 1, while: isUnauthorized }),
    );

/** An OpenAI client pointed at the ChatGPT subscription backend. */
export const layerClient: Layer.Layer<
  OpenAiClient.OpenAiClient,
  never,
  CodexAuth | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* CodexAuth;
    const { OpenAiClient } = yield* Clients.openai;
    const sessionId = crypto.randomUUID();
    return OpenAiClient.layer({
      apiUrl: CODEX_API_URL,
      transformClient: (client) =>
        client.pipe(withCodexAuth(auth, sessionId), withStreamOnlyBackend),
    });
  }),
);
