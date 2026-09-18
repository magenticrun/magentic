/**
 * The relay on Cloudflare.
 *
 * The Worker does routing and nothing else: it decides which gateway a
 * request belongs to and hands it to that gateway's Durable Object, which
 * holds both ends of the tunnel. Admin calls are checked here, against the
 * `RELAY_ADMIN_TOKEN` secret, before any object is touched.
 */

import { bearerFrom, gatewayOf, isGatewayId, timingSafeEqual } from "./credentials.ts";
import { CONNECT_PATH, RESERVED_PREFIX } from "./protocol.ts";
import {
  ADMIN_HEADER,
  GATEWAY_HEADER,
  IP_HEADER,
  OP_HEADER,
  RELAY_AGENT,
  type Env,
} from "./object.ts";

export { GatewayLink } from "./object.ts";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Which gateway a device's hostname names. */
const routeOf = (url: URL, env: Env): string | null => {
  const host = url.hostname.toLowerCase();
  const configured = env.RELAY_ZONE ?? "";
  const zone =
    configured === "" ? null : configured.startsWith(".") ? configured : `.${configured}`;
  if (zone !== null && host.endsWith(zone.toLowerCase())) {
    const id = host.slice(0, -zone.length);
    if (isGatewayId(id)) return id;
  }
  const fallback = env.RELAY_GATEWAY ?? "";
  return isGatewayId(fallback) ? fallback : null;
};

/** The same request, plus what the object needs to know about it. */
const forward = (request: Request, env: Env, gatewayId: string, op: string, admin: string) => {
  const headers = new Headers(request.headers);
  headers.set(OP_HEADER, op);
  headers.set(GATEWAY_HEADER, gatewayId);
  headers.set(ADMIN_HEADER, admin);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip !== null) headers.set(IP_HEADER, ip);
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName(gatewayId));
  return stub.fetch(new Request(request, { headers }));
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === CONNECT_PATH) {
      const token = bearerFrom(request);
      const claimed = token === null ? null : gatewayOf(token);
      if (claimed === null) return json(401, { error: "a gateway credential is required" });
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return json(426, { error: "connect with a WebSocket" });
      }
      return forward(request, env, claimed, "connect", "");
    }

    if (url.pathname === `${RESERVED_PREFIX}health`) {
      const gatewayId = routeOf(url, env);
      if (gatewayId === null) return json(200, { relay: RELAY_AGENT, gateway: null });
      const status = await forward(request, env, gatewayId, "status", "");
      const body = await status.json<{ connected: boolean }>();
      return json(200, { relay: RELAY_AGENT, gateway: gatewayId, connected: body.connected });
    }

    if (url.pathname.startsWith(`${RESERVED_PREFIX}admin/`)) {
      const secret = env.RELAY_ADMIN_TOKEN ?? "";
      if (secret === "") return json(404, { error: "no admin API is configured" });
      const token = bearerFrom(request);
      if (token === null || !timingSafeEqual(token, secret)) {
        return json(401, { error: "the admin token is required" });
      }
      const path = url.pathname.slice(`${RESERVED_PREFIX}admin/`.length);
      const parts = path.split("/").filter((part) => part !== "");
      if (parts[0] !== "gateways" || parts[1] === undefined || !isGatewayId(parts[1])) {
        return json(404, { error: "no such admin route" });
      }
      return forward(request, env, parts[1], "admin", parts.slice(2).join("/"));
    }

    if (url.pathname.startsWith(RESERVED_PREFIX)) {
      return json(404, { error: "no such relay route" });
    }

    const gatewayId = routeOf(url, env);
    if (gatewayId === null) {
      return json(404, { error: "this hostname does not name a gateway on this relay" });
    }
    return forward(request, env, gatewayId, "device", "");
  },
};
