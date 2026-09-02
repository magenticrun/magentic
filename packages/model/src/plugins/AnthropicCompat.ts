import { Effect, Predicate, type Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

/**
 * Effect's Anthropic schemas require these usage keys to be present (null is
 * fine, absent is not). Anthropic always sends them; a compatible endpoint
 * (Z.AI, a gateway such as OpenCode Zen) may not, so the client fills the
 * gaps before decoding.
 */
const MESSAGE_USAGE_KEYS = [
  "cache_creation",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "inference_geo",
  "service_tier",
] as const;

const DELTA_USAGE_KEYS = [
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens",
] as const;

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const withNulls = (usage: Schema.JsonObject, keys: ReadonlyArray<string>): Schema.JsonObject => {
  const missing = keys.filter((key) => !(key in usage)).map((key) => [key, null] as const);
  return missing.length === 0 ? usage : { ...usage, ...Object.fromEntries(missing) };
};

/** A message, `message_start`, or `message_delta` payload with usage keys the schema needs. */
export const normalizeAnthropicJson = (value: Schema.Json): Schema.Json => {
  if (!isJsonObject(value)) {
    return value;
  }
  const usage = value["usage"];
  switch (value["type"]) {
    case "message":
      return isJsonObject(usage)
        ? { ...value, usage: withNulls(usage, MESSAGE_USAGE_KEYS) }
        : value;
    case "message_delta":
      return isJsonObject(usage) ? { ...value, usage: withNulls(usage, DELTA_USAGE_KEYS) } : value;
    case "message_start": {
      const message = value["message"];
      return isJsonObject(message) ? { ...value, message: normalizeAnthropicJson(message) } : value;
    }
    default:
      return value;
  }
};

/** One SSE line; only `data:` lines carrying JSON are touched. */
export const normalizeSseLine = (line: string): string => {
  if (!line.startsWith("data:")) {
    return line;
  }
  try {
    return `data: ${JSON.stringify(normalizeAnthropicJson(JSON.parse(line.slice(5))))}`;
  } catch {
    return line;
  }
};

const isEventStream = (response: HttpClientResponse.HttpClientResponse) =>
  (response.headers["content-type"] ?? "").includes("text/event-stream");

/** The response headers minus the length, which no longer matches a rewritten body. */
const headersFor = (response: HttpClientResponse.HttpClientResponse) =>
  Object.fromEntries(
    Object.entries(response.headers).filter(([name]) => name !== "content-length"),
  );

const normalizeResponse = Effect.fn("anthropicCompatibleClient.normalize")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const init = { status: response.status, headers: headersFor(response) };
  if (isEventStream(response)) {
    const body = response.stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.map((line) => `${normalizeSseLine(line)}\n`),
      Stream.encodeText,
      Stream.toReadableStream(),
    );
    return HttpClientResponse.fromWeb(response.request, new Response(body, init));
  }
  const text = yield* response.text;
  let normalized = text;
  try {
    normalized = JSON.stringify(normalizeAnthropicJson(JSON.parse(text)));
  } catch {
    // Not JSON (an HTML error page, say): the client reports it as is.
  }
  return HttpClientResponse.fromWeb(response.request, new Response(normalized, init));
});

/** An HttpClient whose Anthropic-shaped responses decode even when usage keys are missing. */
export const anthropicCompatibleClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, Effect.flatMap(normalizeResponse));
