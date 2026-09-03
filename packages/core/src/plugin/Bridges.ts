import type {
  BridgePerson,
  BridgeRunError,
  BridgeRunInput,
  HttpRouteMethod,
} from "@magentic/plugin";
import type { RunEvent } from "@magentic/protocol";
import { Context, Deferred, Effect, Layer, type Stream } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/** A bridge's ask, with the surface and provider it registered under. */
export interface BridgeRunRequest extends BridgeRunInput {
  readonly surface: string;
  readonly provider: string;
}

export interface BridgeSteerRequest {
  readonly surface: string;
  readonly provider: string;
  readonly conversationId: string;
  readonly input: string;
  readonly onBehalfOf: BridgePerson;
}

/**
 * What the gateway does when a bridge asks for a run: mint the principal,
 * admit it, record it, and run. The host holds the slot and hands bridges a
 * handle over it; the gateway connects the implementation once the runner
 * exists, which is after the host, since the runner takes its tools from
 * the host. A bridge that asks before then waits.
 */
export interface BridgeRunner {
  run(request: BridgeRunRequest): Stream.Stream<RunEvent, BridgeRunError>;
  steer(request: BridgeSteerRequest): Effect.Effect<boolean, BridgeRunError>;
  notice(conversationId: string, text: string): Effect.Effect<void>;
}

export class BridgeBackend extends Context.Service<
  BridgeBackend,
  {
    /** The gateway's implementation, once connected. */
    readonly runner: Effect.Effect<BridgeRunner>;
    /** Connect the implementation; a second connection is ignored. */
    connect(runner: BridgeRunner): Effect.Effect<void>;
  }
>()("magentic/core/BridgeBackend") {
  static readonly make: Effect.Effect<BridgeBackend["Service"]> = Effect.map(
    Deferred.make<BridgeRunner>(),
    (slot) =>
      BridgeBackend.of({
        runner: Deferred.await(slot),
        connect: (runner) => Effect.asVoid(Deferred.succeed(slot, runner)),
      }),
  );

  static readonly layer = Layer.effect(BridgeBackend, BridgeBackend.make);
}

/** One route a plugin serves, its handler bound to the services it was built with. */
export interface RouteEntry {
  readonly plugin: string;
  readonly method: HttpRouteMethod;
  /** Relative to `/plugins/<plugin>/`, without a leading slash. */
  readonly path: string;
  readonly handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

/** The routes every plugin registered, for the gateway to mount under `/plugins/`. */
export class PluginRoutes extends Context.Service<
  PluginRoutes,
  {
    readonly entries: Effect.Effect<ReadonlyArray<RouteEntry>>;
  }
>()("magentic/core/PluginRoutes") {}

/** What a plugin route's path may look like: segments of lower-case letters, digits, `_` and `-`. */
export const ROUTE_PATH = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
