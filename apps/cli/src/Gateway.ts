import { dataDir } from "@magentic/core";
import { ModelCatalog } from "@magentic/plugin";
import { Api, RPC_PATH } from "@magentic/protocol";
import { Effect, FileSystem, Layer, Logger, Option, Path, Schedule, Schema } from "effect";
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
 * Where an embedded gateway writes its log, appended to across sessions. The
 * terminal is the chat's, or the one-shot run's output, so plugin and MCP
 * server logs cannot go there; they stay readable here for when a server
 * does not connect.
 */
const embeddedLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* dataDir;
  yield* fs.makeDirectory(dir, { recursive: true });
  return yield* Logger.toFile(Logger.formatLogFmt, path.join(dir, "gateway.log"), { flag: "a" });
});

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
  // chat; everything else the gateway logs goes to a file for the same
  // reason. The catalog this process already has, when it has one, is shared.
  const catalog = yield* Effect.serviceOption(ModelCatalog);
  const options = Option.match(catalog, {
    onNone: () => ({ quiet: true }),
    onSome: (service) => ({ quiet: true, catalog: Layer.succeed(ModelCatalog, service) }),
  });
  const logger = yield* embeddedLogger;
  yield* Layer.build(layerServer(port, options)).pipe(Effect.provide(Logger.layer([logger])));
  yield* client.health().pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }));
  return { client, embedded: true };
});

export type GatewayClient = Effect.Success<ReturnType<typeof gatewayClient>>;
