import { DateTime, Effect, Encoding, Layer, Ref } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { AUTH_CLAIMS, CodexTokens } from "./CodexTokens.ts";

/** The claims our fakes need; real tokens carry many more. */
export interface JwtPayload {
  readonly exp?: number;
  readonly sub?: string;
  readonly [AUTH_CLAIMS]?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_plan_type?: string;
  };
}

/** An unsigned JWT with the given payload; only the payload is ever read. */
export const fakeJwt = (payload: JwtPayload): string =>
  ["e30", Encoding.encodeBase64Url(JSON.stringify(payload)), "sig"].join(".");

export const fakeTokens = (options: {
  readonly expiresInSeconds: number;
  readonly accountId?: string;
  readonly refreshToken?: string;
}) =>
  Effect.map(DateTime.now, (now) => {
    const accountId = options.accountId ?? "acct_1";
    const exp = Math.floor(DateTime.toEpochMillis(now) / 1000) + options.expiresInSeconds;
    return new CodexTokens({
      idToken: fakeJwt({
        [AUTH_CLAIMS]: { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
      }),
      accessToken: fakeJwt({ exp, [AUTH_CLAIMS]: { chatgpt_account_id: accountId } }),
      refreshToken: options.refreshToken ?? "refresh_1",
      accountId,
      lastRefresh: now,
    });
  });

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

/**
 * An HttpClient that answers from a script and records what it was asked.
 * Each call consumes the next scripted response; the last one repeats.
 */
export const fakeHttp = (
  responses: ReadonlyArray<{
    readonly status: number;
    readonly body?: string;
    readonly contentType?: string;
  }>,
) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<RecordedRequest>>([]);
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const seen = yield* Ref.get(requests);
        yield* Ref.set(requests, [
          ...seen,
          { url: request.url, headers: { ...request.headers }, body: bodyText(request) },
        ]);
        const scripted = responses[Math.min(seen.length, responses.length - 1)];
        return HttpClientResponse.fromWeb(
          request,
          new Response(scripted?.body ?? "", {
            status: scripted?.status ?? 500,
            headers: { "content-type": scripted?.contentType ?? "application/json" },
          }),
        );
      }),
    );
    return { layer: Layer.succeed(HttpClient.HttpClient, client), requests: Ref.get(requests) };
  });
