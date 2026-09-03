import { Effect, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/**
 * The subscription backend answers `{"detail":"Stream must be set to true"}` to
 * any non-streaming call. The OpenAI client makes such calls for `generateText`
 * and `generateObject`, so those requests are turned into streaming ones here
 * and the final `response.completed` event is returned as the JSON body the
 * client was expecting. Streaming requests pass through untouched.
 */

/** Kept whole, so the rewrite carries every field the client sent. */
const RequestBody = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/**
 * The events that matter. The subscription backend sends `response.completed`
 * with an empty `output`; the items only ever arrive via `output_item.done`.
 */
const StreamEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    item: Schema.optionalKey(Schema.Unknown),
    // Kept as an open record so every field the backend sent survives the round trip.
    response: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

const OutputItems = Schema.Array(Schema.Unknown);

const bodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;

/** The body of a non-streaming call to `/responses`; none for any other request. */
const nonStreamingResponsesBody = (request: HttpClientRequest.HttpClientRequest) => {
  const none = Option.none<typeof RequestBody.Type>();
  if (request.method !== "POST" || !request.url.endsWith("/responses")) {
    return none;
  }
  const text = bodyText(request);
  if (text === undefined) {
    return none;
  }
  return Schema.decodeOption(RequestBody)(text).pipe(
    Option.filter((body) => body["stream"] !== true),
  );
};

const transportError = (request: HttpClientRequest.HttpClientRequest, description: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  });

/** Assembles the JSON the non-streaming endpoint would have returned. */
const collectFinalResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const text = yield* response.text;
    const items: Array<typeof Schema.Unknown.Type> = [];
    for (const chunk of text.split("\n\n")) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const decoded = Schema.decodeOption(StreamEvent)(line.slice(5).trim());
        if (decoded._tag !== "Some") {
          continue;
        }
        const event = decoded.value;
        switch (event.type) {
          case "response.output_item.done":
            if (event.item !== undefined) {
              items.push(event.item);
            }
            continue;
          case "response.completed":
          case "response.incomplete": {
            if (event.response === undefined) {
              continue;
            }
            const sent = Schema.decodeUnknownOption(OutputItems)(event.response["output"]);
            const output = sent._tag === "Some" && sent.value.length > 0 ? sent.value : items;
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ ...event.response, output }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          case "response.failed":
            return yield* transportError(
              request,
              `model request failed: ${JSON.stringify(event.response)}`,
            );
          default:
            continue;
        }
      }
    }
    return yield* transportError(request, "stream ended without a response.completed event");
  });

export const withStreamOnlyBackend = (client: HttpClient.HttpClient): HttpClient.HttpClient => {
  /** Requests this shim rewrote, so the response side knows to collect the stream. */
  const rewritten = new WeakSet<HttpClientRequest.HttpClientRequest>();
  return client.pipe(
    HttpClient.mapRequestEffect((request) => {
      const body = nonStreamingResponsesBody(request);
      if (Option.isNone(body)) {
        return Effect.succeed(request);
      }
      const patched = JSON.stringify({ ...body.value, stream: true });
      return HttpClientRequest.bodyText(request, patched, "application/json").pipe(
        HttpClientRequest.setHeader("accept", "text/event-stream"),
        (next) => {
          rewritten.add(next);
          return Effect.succeed(next);
        },
      );
    }),
    HttpClient.transform((responseEffect, request) =>
      rewritten.has(request)
        ? responseEffect.pipe(Effect.flatMap((response) => collectFinalResponse(request, response)))
        : responseEffect,
    ),
  );
};
