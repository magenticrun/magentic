import { layerServer } from "@magentic/gateway";
import { Api } from "@magentic/protocol";
import { Effect, flow, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()(
  "GatewayUnreachable",
  { url: Schema.String, message: Schema.String },
) {}

export const gatewayClient = (baseUrl: string) =>
  HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(baseUrl))),
  });

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/**
 * A client for the gateway at `baseUrl`. When nothing answers there and the
 * URL is local, the gateway is started inside this process for as long as the
 * surrounding scope lives, so `magentic` on a laptop just works.
 */
export const ensureGateway = Effect.fn("Cli.ensureGateway")(function* (baseUrl: string) {
  const client = yield* gatewayClient(baseUrl);
  if (yield* Effect.isSuccess(client.health())) {
    return { client, embedded: false };
  }
  const url = new URL(baseUrl);
  if (!isLocal(url)) {
    return yield* new GatewayUnreachable({
      url: baseUrl,
      message: `no gateway answered at ${baseUrl}`,
    });
  }
  const port = url.port === "" ? 80 : Number.parseInt(url.port, 10);
  // Request logs would land in the transcript, or on top of the full-screen chat.
  yield* Layer.build(layerServer(port, { quiet: true }));
  yield* client.health().pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }));
  return { client, embedded: true };
});

export type GatewayClient = Effect.Success<ReturnType<typeof gatewayClient>>;
