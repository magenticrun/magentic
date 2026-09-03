import type { Effect, Scope } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { PluginSetupError, Registration } from "./Plugin.ts";

export type HttpRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request to one of the plugin's routes. The plugin reads the raw body
 * itself, since a webhook signature is over the bytes as sent, and answers
 * with a response for every outcome: a handler has no error channel.
 */
export type HttpRouteHandler<R> = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>;

/**
 * Routes a plugin serves, mounted under `/plugins/<plugin id>/` on the
 * gateway's one listener. The prefix keeps a plugin from claiming `/rpc` or
 * another plugin's path. Only a bridge that receives HTTP needs this; a
 * poller is a loop in the plugin's scope and a socket is outbound.
 */
export interface HttpDomain {
  /**
   * `path` is relative to the plugin's prefix, without a leading slash:
   * `webhook` serves `/plugins/github/webhook`. The handler's services are
   * captured now and provided back on every request.
   */
  route<R>(
    method: HttpRouteMethod,
    path: string,
    handler: HttpRouteHandler<R>,
  ): Effect.Effect<Registration, PluginSetupError, Scope.Scope | R>;
}
