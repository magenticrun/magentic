import { ModelCatalog } from "@magentic/plugin";
import { Api, RPC_PATH } from "@magentic/protocol";
import { Effect, Layer, Option, Schedule, Schema } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()("GatewayUnreachable", {
  url: Schema.String,
  message: Schema.String,
}) {}

/** A typed client for the gateway at `baseUrl`, alive as long as the scope. */
export const gatewayClient = (baseUrl: string) =>
  RpcClient.make(Api).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `${baseUrl}${RPC_PATH}` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  );

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
  // The server is loaded only now: most starts find a gateway already running.
  const { layerServer } = yield* Effect.promise(() => import("@magentic/gateway"));
  // Request logs would land in the transcript, or on top of the full-screen
  // chat. The catalog this process already has, when it has one, is shared.
  const catalog = yield* Effect.serviceOption(ModelCatalog);
  const options = Option.match(catalog, {
    onNone: () => ({ quiet: true }),
    onSome: (service) => ({ quiet: true, catalog: Layer.succeed(ModelCatalog, service) }),
  });
  yield* Layer.build(layerServer(port, options));
  yield* client.health().pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }));
  return { client, embedded: true };
});

export type GatewayClient = Effect.Success<ReturnType<typeof gatewayClient>>;
