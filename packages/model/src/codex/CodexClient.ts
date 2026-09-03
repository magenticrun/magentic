import type { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as Clients from "../Clients.ts";
import { CODEX_API_URL, CODEX_ORIGINATOR, CODEX_USER_AGENT } from "./Constants.ts";
import { CodexAuth } from "./CodexAuth.ts";
import { withStreamOnlyBackend } from "./CodexStreamShim.ts";

const isUnauthorized = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "StatusCodeError" && error.reason.response.status === 401;

/** Auth failures surface through the HTTP error channel the OpenAI client already handles. */
const asTransport = (
  request: HttpClientRequest.HttpClientRequest,
  error: { readonly message: string },
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: error.message,
      cause: error,
    }),
  });

/**
 * Turns any HttpClient into one that speaks to the Codex backend as the
 * logged-in ChatGPT account: bearer token and account header on every request,
 * one refresh-and-retry on a 401.
 *
 * The token is read inside the effect that is retried, not in the request
 * pipeline in front of it, so the second try carries the refreshed token
 * whatever else is composed around this client. A refresh the backend
 * rejects ends the call with its reason, which says to log in again, instead
 * of a second 401 that says nothing.
 */
export const withCodexAuth =
  (auth: CodexAuth["Service"], sessionId: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.transform(client, (_, request) => {
      const send = auth.current.pipe(
        Effect.mapError((error) => asTransport(request, error)),
        Effect.flatMap((tokens) =>
          client.postprocess(
            Effect.succeed(
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
          ),
        ),
      );
      return send.pipe(
        Effect.tapError((error) =>
          isUnauthorized(error)
            ? auth.refresh.pipe(Effect.mapError((failure) => asTransport(request, failure)))
            : Effect.void,
        ),
        Effect.retry({ times: 1, while: isUnauthorized }),
      );
    });

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
