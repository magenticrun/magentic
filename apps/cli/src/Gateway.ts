import { dataDir, describeCause } from "@magentic/core";
import { ModelCatalog } from "@magentic/plugin";
import { Api, RPC_PATH } from "@magentic/protocol";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

class GatewayUnreachable extends Schema.TaggedError<GatewayUnreachable>()("GatewayUnreachable", {
  url: Schema.String,
  message: Schema.String,
}) {}

/** A typed client for the gateway at `baseUrl`, alive as long as the scope. */
const gatewayClient = (baseUrl: string) =>
  RpcClient.make(Api).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `${baseUrl}${RPC_PATH}` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  );

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/**
 * How long one health check may take. Something that accepts a connection
 * and never answers — a half-open socket, a gateway whose routes are not
 * mounted yet, a black-holing firewall — would otherwise hang the CLI
 * before it has printed a word.
 */
const HEALTH_TIMEOUT = Duration.seconds(5);
/** How long the whole wait for a gateway to come up may take. */
const START_TIMEOUT = Duration.seconds(30);

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
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  // The person's own, like everything else under the data directory: the log
  // carries what the MCP servers print and what the gateway warns about.
  return yield* Logger.toFile(Logger.formatLogFmt, path.join(dir, "gateway.log"), {
    flag: "a",
    mode: 0o600,
  });
});

/**
 * A client for the gateway at `baseUrl`. When nothing answers there and the
 * URL is local, the gateway is started inside this process for as long as the
 * surrounding scope lives, so `magentic` on a laptop just works.
 */
export const ensureGateway = Effect.fn("Cli.ensureGateway")(function* (baseUrl: string) {
  const client = yield* gatewayClient(baseUrl);
  const unreachable = (message: string) => new GatewayUnreachable({ url: baseUrl, message });
  /** One health check, a silent peer counted as no gateway rather than waited on. */
  const healthOnce = client.health().pipe(
    Effect.timeoutOrElse({
      duration: HEALTH_TIMEOUT,
      orElse: () =>
        Effect.fail(unreachable(`${baseUrl} accepted the connection but did not answer`)),
    }),
  );
  if (yield* Effect.isSuccess(healthOnce)) {
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
  const waitForHealth = healthOnce.pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    Effect.timeoutOrElse({
      duration: START_TIMEOUT,
      orElse: () => Effect.fail(unreachable(`the gateway at ${baseUrl} did not come up`)),
    }),
  );
  const started = yield* Effect.exit(
    Layer.build(layerServer(port, options)).pipe(Effect.provide(Logger.layer([logger]))),
  );
  if (started._tag === "Failure") {
    // The port is taken. Another gateway is almost certainly there and was
    // still coming up when the health check above missed it: its socket
    // accepts before its routes are mounted. Wait for it rather than hand
    // the person a bind error for a server they never asked to start.
    return yield* Effect.as(waitForHealth, { client, embedded: false }).pipe(
      Effect.catch(() =>
        Effect.fail(
          unreachable(
            `nothing answers at ${baseUrl} and a gateway cannot be started there: ${describeCause(started.cause)}`,
          ),
        ),
      ),
    );
  }
  yield* waitForHealth;
  return { client, embedded: true };
});

export type GatewayClient = Effect.Success<ReturnType<typeof gatewayClient>>;
