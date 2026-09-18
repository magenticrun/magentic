/**
 * The relay as one Bun process.
 *
 * Cloudflare is the recommended home; this is the second choice, for an
 * operator who already runs a box with a hostname and a TLS proxy and would
 * rather not open a Cloudflare account. It is also what the tests drive,
 * because a relay that cannot be run and pointed at is a relay nobody can
 * check.
 */

import type { ServerWebSocket, Server } from "bun";
import {
  bearerFrom,
  gatewayOf,
  isGatewayId,
  mint,
  timingSafeEqual,
  verify,
} from "./credentials.ts";
import { CONNECT_PATH, RESERVED_PREFIX, toBytes } from "./protocol.ts";
import type { CredentialStore } from "./store.ts";
import { forwardedHeaders, Tunnel, type Link } from "./tunnel.ts";

export const RELAY_AGENT = "magentic-relay/0.1.0";

export interface RelayOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly store: CredentialStore;
  /** Guards the admin API. Without one the admin API is not served at all. */
  readonly adminToken: string | null;
  /** Suffix that makes a hostname name a gateway: `.relay.example.com`. */
  readonly zone?: string | null;
  /** The gateway every other hostname belongs to, for a one-gateway relay. */
  readonly defaultGateway?: string | null;
  readonly onLog?: (line: string) => void;
}

type SocketData =
  | { readonly kind: "gateway"; readonly gatewayId: string; readonly fingerprint: string }
  | { readonly kind: "device"; readonly gatewayId: string; readonly id: number };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const wantsWebSocket = (request: Request): boolean =>
  (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

const linkFor = (socket: ServerWebSocket<SocketData>): Link => ({
  sendText: (data) => {
    socket.send(data);
  },
  sendBinary: (data) => {
    socket.send(data);
  },
  close: (code, reason) => {
    socket.close(code, reason);
  },
});

export interface Relay {
  readonly server: Server<SocketData>;
  readonly stop: () => Promise<void>;
}

export const serve = (options: RelayOptions): Relay => {
  const log = options.onLog ?? (() => undefined);
  const zone =
    options.zone === null || options.zone === undefined || options.zone === ""
      ? null
      : options.zone.startsWith(".")
        ? options.zone.toLowerCase()
        : `.${options.zone.toLowerCase()}`;

  const tunnels = new Map<string, Tunnel>();
  const links = new WeakMap<ServerWebSocket<SocketData>, Link>();
  /** Which credential the currently connected gateway used, so revoking it bites. */
  const inUse = new Map<string, string>();

  const tunnelFor = (gatewayId: string): Tunnel => {
    const existing = tunnels.get(gatewayId);
    if (existing !== undefined) return existing;
    const created = new Tunnel({ gatewayId, relay: RELAY_AGENT, onLog: log });
    tunnels.set(gatewayId, created);
    return created;
  };

  /** Which gateway a device's hostname belongs to. */
  const routeOf = (request: Request): string | null => {
    const host = new URL(request.url).hostname.toLowerCase();
    if (zone !== null && host.endsWith(zone)) {
      const id = host.slice(0, -zone.length);
      if (isGatewayId(id)) return id;
    }
    const fallback = options.defaultGateway ?? null;
    return fallback !== null && isGatewayId(fallback) ? fallback : null;
  };

  const connect = async (request: Request, server: Server<SocketData>): Promise<Response> => {
    const token = bearerFrom(request);
    const claimed = token === null ? null : gatewayOf(token);
    if (token === null || claimed === null) {
      return json(401, { error: "a gateway credential is required" });
    }
    const credential = await verify(token, await options.store.list(claimed));
    if (credential === null) return json(401, { error: "unknown or revoked credential" });
    if (!wantsWebSocket(request)) return json(426, { error: "connect with a WebSocket" });
    const data: SocketData = {
      kind: "gateway",
      gatewayId: claimed,
      fingerprint: credential.fingerprint,
    };
    return server.upgrade(request, { data })
      ? new Response(null, { status: 101 })
      : json(400, { error: "the upgrade was refused" });
  };

  const admin = async (request: Request, path: string): Promise<Response> => {
    if (options.adminToken === null) return json(404, { error: "no admin API is configured" });
    const token = bearerFrom(request);
    if (token === null || !timingSafeEqual(token, options.adminToken)) {
      return json(401, { error: "the admin token is required" });
    }
    // /gateways/<id>[/credentials[/<fingerprint>]]
    const parts = path.split("/").filter((part) => part !== "");
    if (parts[0] !== "gateways" || parts[1] === undefined || !isGatewayId(parts[1])) {
      return json(404, { error: "no such admin route" });
    }
    const gatewayId = parts[1];
    if (parts[2] === undefined) {
      if (request.method !== "GET") return json(405, { error: "GET only" });
      return json(200, tunnelFor(gatewayId).status());
    }
    if (parts[2] !== "credentials") return json(404, { error: "no such admin route" });
    if (parts[3] === undefined) {
      if (request.method === "GET") {
        const credentials = await options.store.list(gatewayId);
        return json(200, {
          credentials: credentials.map((credential) => ({
            fingerprint: credential.fingerprint,
            label: credential.label,
            createdAt: credential.createdAt,
          })),
        });
      }
      if (request.method !== "POST") return json(405, { error: "GET or POST" });
      const body = await request.json().catch(() => ({}));
      const label = (body as { label?: string }).label ?? "";
      const minted = await mint(gatewayId, label, Date.now());
      await options.store.add(gatewayId, minted.credential);
      log(`minted a credential for ${gatewayId} (${minted.credential.fingerprint})`);
      return json(201, {
        token: minted.token,
        fingerprint: minted.credential.fingerprint,
        label: minted.credential.label,
        createdAt: minted.credential.createdAt,
        gatewayId,
      });
    }
    if (request.method !== "DELETE") return json(405, { error: "DELETE only" });
    const removed = await options.store.remove(gatewayId, parts[3]);
    if (!removed) return json(404, { error: "no such credential" });
    if (inUse.get(gatewayId) === parts[3]) {
      inUse.delete(gatewayId);
      tunnelFor(gatewayId).closeGateway(4401, "credential revoked");
    }
    log(`revoked credential ${parts[3]} for ${gatewayId}`);
    return new Response(null, { status: 204 });
  };

  const device = async (request: Request, server: Server<SocketData>): Promise<Response> => {
    const gatewayId = routeOf(request);
    if (gatewayId === null) {
      return json(404, { error: "this hostname does not name a gateway on this relay" });
    }
    const tunnel = tunnelFor(gatewayId);
    const forwarded = forwardedHeaders(request, server.requestIP(request)?.address ?? null);
    if (!wantsWebSocket(request)) return tunnel.request(request, forwarded);
    const result = await tunnel.upgrade(request, forwarded);
    if (!result.ok) return json(result.status, { error: result.message });
    const data: SocketData = { kind: "device", gatewayId, id: result.id };
    const headers =
      result.protocol === null ? undefined : { "sec-websocket-protocol": result.protocol };
    if (server.upgrade(request, { data, headers })) return new Response(null, { status: 101 });
    tunnel.socketClosed(result.id, 1011, "the upgrade was refused");
    return json(400, { error: "the upgrade was refused" });
  };

  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname ?? "0.0.0.0",
    // A relay holds sockets open for as long as the gateway is awake.
    idleTimeout: 255,
    fetch: (request, self) => {
      const url = new URL(request.url);
      if (url.pathname === CONNECT_PATH) return connect(request, self);
      if (url.pathname === `${RESERVED_PREFIX}health`) {
        const gatewayId = routeOf(request);
        return json(200, {
          relay: RELAY_AGENT,
          gateway: gatewayId,
          connected: gatewayId !== null && tunnelFor(gatewayId).connected,
        });
      }
      if (url.pathname.startsWith(`${RESERVED_PREFIX}admin/`)) {
        return admin(request, url.pathname.slice(`${RESERVED_PREFIX}admin`.length));
      }
      if (url.pathname.startsWith(RESERVED_PREFIX)) {
        return json(404, { error: "no such relay route" });
      }
      return device(request, self);
    },
    websocket: {
      idleTimeout: 255,
      open: (socket) => {
        const link = linkFor(socket);
        links.set(socket, link);
        const data = socket.data;
        if (data.kind === "gateway") {
          inUse.set(data.gatewayId, data.fingerprint);
          tunnelFor(data.gatewayId).attachGateway(link);
          log(`gateway ${data.gatewayId} connected`);
        } else {
          tunnelFor(data.gatewayId).bindSocket(data.id, link);
        }
      },
      message: (socket, message) => {
        const data = socket.data;
        const tunnel = tunnelFor(data.gatewayId);
        if (data.kind === "gateway") {
          if (ArrayBuffer.isView(message)) tunnel.gatewayBinary(toBytes(message));
          else tunnel.gatewayText(message);
          return;
        }
        if (ArrayBuffer.isView(message)) tunnel.socketBinary(data.id, toBytes(message));
        else tunnel.socketText(data.id, message);
      },
      close: (socket, code, reason) => {
        const data = socket.data;
        const tunnel = tunnelFor(data.gatewayId);
        if (data.kind === "gateway") {
          const link = links.get(socket);
          if (link !== undefined) tunnel.detachGateway(link);
          if (inUse.get(data.gatewayId) === data.fingerprint) inUse.delete(data.gatewayId);
          log(`gateway ${data.gatewayId} disconnected (${code})`);
          return;
        }
        tunnel.socketClosed(data.id, code, reason);
      },
    },
  });

  return {
    server,
    stop: async () => {
      await server.stop(true);
    },
  };
};
