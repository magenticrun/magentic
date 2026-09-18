/**
 * One Durable Object per gateway.
 *
 * The gateway's outbound socket and every device socket for that gateway land
 * on the same object, which is what makes the relay a forwarder rather than a
 * distributed system: there is exactly one place that knows both ends. The
 * object holds no conversation state, so when nothing is being said it
 * hibernates, and the sockets stay open while it sleeps.
 */

import { DurableObject } from "cloudflare:workers";
import { mint, verify, type Credential } from "./credentials.ts";
import { PING, PONG, toBytes } from "./protocol.ts";
import { forwardedHeaders, Tunnel, type Link } from "./tunnel.ts";

export const RELAY_AGENT = "magentic-relay/0.1.0";

/** Headers the Worker adds; a device's own copies are dropped before this. */
export const OP_HEADER = "x-relay-op";
export const GATEWAY_HEADER = "x-relay-gateway";
export const ADMIN_HEADER = "x-relay-admin";
export const IP_HEADER = "x-relay-ip";

export interface Env {
  readonly GATEWAY: DurableObjectNamespace<GatewayLink>;
  readonly RELAY_ADMIN_TOKEN?: string;
  readonly RELAY_ZONE?: string;
  readonly RELAY_GATEWAY?: string;
}

interface GatewayAttachment {
  readonly kind: "gateway";
  readonly fingerprint: string;
  readonly since: number;
}

interface DeviceAttachment {
  readonly kind: "device";
  readonly id: number;
}

type Attachment = GatewayAttachment | DeviceAttachment;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * One `Link` per socket, for the life of the socket. The tunnel decides which
 * gateway is the current one by identity, so handing it a fresh wrapper on
 * every event would mean a gateway that never detaches: its streams would
 * outlive its socket and a reconnect would never take over.
 */
const wrappers = new WeakMap<WebSocket, Link>();

const linkFor = (socket: WebSocket): Link => {
  const existing = wrappers.get(socket);
  if (existing !== undefined) return existing;
  const link: Link = {
    sendText: (data) => {
      socket.send(data);
    },
    sendBinary: (data) => {
      socket.send(data);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
  };
  wrappers.set(socket, link);
  return link;
};

const attachmentOf = (socket: WebSocket): Attachment | null => {
  const value = socket.deserializeAttachment();
  // SAFETY: only this class ever attaches, and it attaches Attachment.
  const attachment = value as Attachment | null;
  return attachment === null || attachment === undefined ? null : attachment;
};

/** What an object calls itself before its first request names it. */
const UNNAMED = "";

export class GatewayLink extends DurableObject<Env> {
  #tunnel: Tunnel;
  #gatewayId: string = UNNAMED;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#tunnel = new Tunnel({ gatewayId: this.#gatewayId, relay: RELAY_AGENT });
    // Keepalives must not cost a wake-up; the runtime answers them for us.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<string>("gatewayId");
      if (stored !== undefined) {
        this.#gatewayId = stored;
        this.#tunnel = new Tunnel({ gatewayId: stored, relay: RELAY_AGENT });
      }
      // Sockets outlive us. Whatever is still open is still ours.
      for (const socket of ctx.getWebSockets()) {
        const attachment = attachmentOf(socket);
        if (attachment === null) continue;
        if (attachment.kind === "gateway") {
          this.#tunnel.restoreGateway(linkFor(socket), attachment.since);
        } else this.#tunnel.restoreSocket(attachment.id, linkFor(socket));
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    // An object is reached by a name derived from the gateway id, so the id
    // arrives with the first request and never changes after. Adopting a
    // later one would silently drop the sockets the object is already holding.
    const gatewayId = request.headers.get(GATEWAY_HEADER);
    if (gatewayId !== null && this.#gatewayId === UNNAMED) {
      this.#gatewayId = gatewayId;
      await this.ctx.storage.put("gatewayId", gatewayId);
      this.#tunnel = new Tunnel({ gatewayId, relay: RELAY_AGENT });
    }
    switch (request.headers.get(OP_HEADER)) {
      case "connect": {
        return this.#connect(request);
      }
      case "admin": {
        return this.#admin(request);
      }
      case "status": {
        return json(200, this.#tunnel.status());
      }
      default: {
        return this.#device(request);
      }
    }
  }

  // -- the gateway ---------------------------------------------------------

  async #connect(request: Request): Promise<Response> {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const credential = await verify(token, await this.#credentials());
    if (credential === null) return json(401, { error: "unknown or revoked credential" });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const since = Date.now();
    this.ctx.acceptWebSocket(server, ["gateway"]);
    const attachment: GatewayAttachment = {
      kind: "gateway",
      fingerprint: credential.fingerprint,
      since,
    };
    server.serializeAttachment(attachment);
    this.#tunnel.attachGateway(linkFor(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  // -- devices -------------------------------------------------------------

  async #device(request: Request): Promise<Response> {
    const forwarded = forwardedHeaders(request, request.headers.get(IP_HEADER));
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return this.#tunnel.request(request, forwarded);
    }
    const result = await this.#tunnel.upgrade(request, forwarded);
    if (!result.ok) return json(result.status, { error: result.message });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`device:${result.id}`]);
    const attachment: DeviceAttachment = { kind: "device", id: result.id };
    server.serializeAttachment(attachment);
    this.#tunnel.bindSocket(result.id, linkFor(server));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: result.protocol === null ? undefined : { "sec-websocket-protocol": result.protocol },
    });
  }

  // -- socket events -------------------------------------------------------

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = attachmentOf(socket);
    if (attachment === null) return;
    const binary = message instanceof ArrayBuffer;
    if (attachment.kind === "gateway") {
      if (binary) this.#tunnel.gatewayBinary(toBytes(message));
      else this.#tunnel.gatewayText(message);
      return;
    }
    if (binary) this.#tunnel.socketBinary(attachment.id, toBytes(message));
    else this.#tunnel.socketText(attachment.id, message);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment = attachmentOf(socket);
    if (attachment === null) return;
    if (attachment.kind === "gateway") this.#tunnel.detachGateway(linkFor(socket));
    else this.#tunnel.socketClosed(attachment.id, code === 1005 ? 1000 : code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket, 1011, "socket error");
  }

  // -- credentials ---------------------------------------------------------

  async #credentials(): Promise<Array<Credential>> {
    return (await this.ctx.storage.get<Array<Credential>>("credentials")) ?? [];
  }

  async #admin(request: Request): Promise<Response> {
    const path = request.headers.get(ADMIN_HEADER) ?? "";
    const parts = path.split("/").filter((part) => part !== "");
    if (parts.length === 0) return json(200, this.#tunnel.status());
    if (parts[0] !== "credentials") return json(404, { error: "no such admin route" });
    const credentials = await this.#credentials();
    if (parts[1] === undefined) {
      if (request.method === "GET") {
        return json(200, {
          credentials: credentials.map((credential) => ({
            fingerprint: credential.fingerprint,
            label: credential.label,
            createdAt: credential.createdAt,
          })),
        });
      }
      if (request.method !== "POST") return json(405, { error: "GET or POST" });
      const body = await request.json<{ label?: string }>().catch(() => ({ label: "" }));
      const minted = await mint(this.#gatewayId, body.label ?? "", Date.now());
      await this.ctx.storage.put("credentials", [...credentials, minted.credential]);
      return json(201, {
        token: minted.token,
        fingerprint: minted.credential.fingerprint,
        label: minted.credential.label,
        createdAt: minted.credential.createdAt,
        gatewayId: this.#gatewayId,
      });
    }
    if (request.method !== "DELETE") return json(405, { error: "DELETE only" });
    const kept = credentials.filter((credential) => credential.fingerprint !== parts[1]);
    if (kept.length === credentials.length) return json(404, { error: "no such credential" });
    await this.ctx.storage.put("credentials", kept);
    for (const socket of this.ctx.getWebSockets("gateway")) {
      const attachment = attachmentOf(socket);
      if (attachment?.kind === "gateway" && attachment.fingerprint === parts[1]) {
        socket.close(4401, "credential revoked");
      }
    }
    return new Response(null, { status: 204 });
  }
}
