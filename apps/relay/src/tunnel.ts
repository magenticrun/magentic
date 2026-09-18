/**
 * The tunnel: one gateway's control link on one side, that gateway's devices
 * on the other.
 *
 * Everything a relay does that is not routing or authentication happens here,
 * and it is written against a `Link` rather than a runtime's socket so the
 * same logic runs inside a Durable Object and inside a Bun process. The
 * device side speaks in `Request` and `Response`, which both runtimes have.
 *
 * A device is never told which of the two it is talking to. It makes an
 * ordinary HTTP request or opens an ordinary WebSocket against the relay's
 * hostname, and the gateway on the other end sees an ordinary client. That
 * is the whole point: pairing, credentials, scopes, policy, and audit stay in
 * the gateway, and the relay authenticates nothing on its behalf.
 */

import {
  CHANNEL,
  decodeFrame,
  encodeFrame,
  forwardableHeaders,
  headersFrom,
  parseControl,
  PING,
  PONG,
  PROTOCOL_VERSION,
  WINDOW_BYTES,
  type FromGateway,
  type HeaderPair,
  type ToGateway,
} from "./protocol.ts";
import { Credit, shouldGrant } from "./credit.ts";

/** One socket, as much of it as the tunnel needs. */
export interface Link {
  readonly sendText: (data: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface TunnelOptions {
  readonly gatewayId: string;
  /** Named in the hello frame, so a connector can log what it reached. */
  readonly relay: string;
  /** How long the gateway has to answer with response headers. */
  readonly responseTimeoutMs?: number;
  /** How long the gateway has to accept or refuse an upgrade. */
  readonly upgradeTimeoutMs?: number;
  readonly onLog?: (line: string) => void;
}

export type UpgradeResult =
  /** `protocol` is the subprotocol the gateway negotiated, to echo back. */
  | { readonly ok: true; readonly id: number; readonly protocol: string | null }
  | { readonly ok: false; readonly status: number; readonly message: string };

export interface TunnelStatus {
  readonly gatewayId: string;
  readonly connected: boolean;
  readonly since: number | null;
  readonly agent: string | null;
  readonly sockets: number;
  readonly requests: number;
}

interface PendingRequest {
  readonly settle: (response: Response) => void;
  /** Room left to forward the device's request body. */
  readonly credit: Credit;
  /** Response bytes taken in since the gateway was last granted room. */
  received: number;
  timer: ReturnType<typeof setTimeout> | null;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  answered: boolean;
}

interface PendingUpgrade {
  readonly settle: (result: UpgradeResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface BufferedMessage {
  readonly text: string | null;
  readonly bytes: Uint8Array | null;
}

/** Statuses whose responses carry no body, whatever the origin says. */
const BODYLESS = new Set([101, 204, 205, 304]);

const problem = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export class Tunnel {
  readonly #options: TunnelOptions;
  readonly #requests = new Map<number, PendingRequest>();
  readonly #upgrades = new Map<number, PendingUpgrade>();
  readonly #sockets = new Map<number, Link>();
  /** Frames for a socket the runtime has not handed back to us yet. */
  readonly #buffered = new Map<number, Array<BufferedMessage>>();
  /** Ids the gateway has accepted, until the runtime binds their socket. */
  readonly #binding = new Set<number>();
  #gateway: Link | null = null;
  #agent: string | null = null;
  #since: number | null = null;
  #nextId = 1;

  constructor(options: TunnelOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#gateway !== null;
  }

  status(): TunnelStatus {
    return {
      gatewayId: this.#options.gatewayId,
      connected: this.#gateway !== null,
      since: this.#since,
      agent: this.#agent,
      sockets: this.#sockets.size,
      requests: this.#requests.size,
    };
  }

  // -- the gateway's side --------------------------------------------------

  /**
   * A gateway proved its credential and its socket is open. A second gateway
   * on the same id replaces the first: it is the same operator reconnecting
   * after a sleep the old link has not noticed yet. The streams belong to the
   * link that carried them, so they end with it.
   */
  attachGateway(link: Link): void {
    if (this.#gateway !== null) {
      const previous = this.#gateway;
      this.#reset(1012, "gateway reconnected");
      previous.close(4409, "replaced by a newer connection");
    }
    this.#gateway = link;
    this.#since = Date.now();
    this.#send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      gatewayId: this.#options.gatewayId,
      relay: this.#options.relay,
    });
  }

  /** The gateway's socket closed. Only the current link may detach. */
  detachGateway(link: Link): void {
    if (this.#gateway !== link) return;
    this.#gateway = null;
    this.#agent = null;
    this.#since = null;
    this.#reset(1012, "gateway disconnected");
  }

  /** Hangs up on the gateway, as a revoked credential must. */
  closeGateway(code: number, reason: string): void {
    this.#gateway?.close(code, reason);
  }

  /** Rebuilds the link after the runtime evicted us and woke us again. */
  restoreGateway(link: Link, since: number): void {
    this.#gateway = link;
    this.#since = since;
  }

  /** Rebuilds a device socket after the same eviction. */
  restoreSocket(id: number, link: Link): void {
    this.#sockets.set(id, link);
    this.#nextId = Math.max(this.#nextId, id + 1);
  }

  gatewayText(text: string): void {
    if (text === PING) {
      this.#gateway?.sendText(PONG);
      return;
    }
    if (text === PONG) return;
    const message = parseControl<FromGateway>(text);
    if (message === null) {
      this.#log(`ignored an unreadable control frame from gateway ${this.#options.gatewayId}`);
      return;
    }
    this.#dispatch(message);
  }

  gatewayBinary(data: Uint8Array): void {
    const frame = decodeFrame(data);
    if (frame === null) return;
    if (frame.channel === CHANNEL.body) {
      const pending = this.#requests.get(frame.id);
      if (pending?.body === undefined || pending.body === null) return;
      pending.received += frame.payload.byteLength;
      pending.body.enqueue(new Uint8Array(frame.payload));
      return;
    }
    const text = frame.channel === CHANNEL.wsText ? new TextDecoder().decode(frame.payload) : null;
    const bytes = text === null ? new Uint8Array(frame.payload) : null;
    const socket = this.#sockets.get(frame.id);
    if (socket === undefined) {
      // The gateway can answer faster than the runtime hands us its end of
      // the device's socket, and a dropped first frame is a hung handshake.
      if (!this.#binding.has(frame.id)) return;
      const waiting = this.#buffered.get(frame.id) ?? [];
      waiting.push({ text, bytes });
      this.#buffered.set(frame.id, waiting);
      return;
    }
    if (text !== null) socket.sendText(text);
    else if (bytes !== null) socket.sendBinary(bytes);
  }

  #dispatch(message: FromGateway): void {
    switch (message.t) {
      case "hello": {
        this.#agent = message.agent;
        return;
      }
      case "res": {
        this.#answer(message);
        return;
      }
      case "res-end": {
        const pending = this.#requests.get(message.id);
        if (pending === undefined) return;
        this.#requests.delete(message.id);
        pending.credit.close();
        pending.body?.close();
        return;
      }
      case "window": {
        this.#requests.get(message.id)?.credit.grant(message.bytes);
        return;
      }
      case "res-error": {
        const pending = this.#requests.get(message.id);
        if (pending === undefined) return;
        this.#requests.delete(message.id);
        pending.credit.close();
        if (pending.answered) pending.body?.error(new Error(message.message));
        else {
          this.#clear(pending);
          pending.settle(problem(message.status, message.message));
        }
        return;
      }
      case "ws-open": {
        this.#settleUpgrade(message.id, {
          ok: true,
          id: message.id,
          protocol: message.protocol,
        });
        return;
      }
      case "ws-reject": {
        this.#settleUpgrade(message.id, {
          ok: false,
          status: message.status,
          message: message.message,
        });
        return;
      }
      case "ws-close": {
        const socket = this.#sockets.get(message.id);
        this.#sockets.delete(message.id);
        this.#buffered.delete(message.id);
        this.#binding.delete(message.id);
        socket?.close(message.code, message.reason);
        return;
      }
    }
  }

  #answer(message: Extract<FromGateway, { t: "res" }>): void {
    const pending = this.#requests.get(message.id);
    if (pending === undefined) return;
    this.#clear(pending);
    pending.answered = true;
    if (BODYLESS.has(message.status) || message.body === "none") {
      this.#requests.delete(message.id);
      pending.settle(
        new Response(null, { status: message.status, headers: headersFrom(message.headers) }),
      );
      return;
    }
    // A response the gateway could not size is one it is still producing.
    // Cloudflare compresses a compressible body by default, and to do that it
    // waits for the whole of it: a streamed answer would arrive in one piece
    // at the end, which is the one thing this has to get right. `no-transform`
    // is how a proxy is told to leave a response alone.
    const headers = headersFrom(message.headers);
    if (!headers.has("content-length")) headers.set("content-encoding", "identity");
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          pending.body = controller;
        },
        // Called whenever the device has read the queue back below the
        // window: the moment the gateway can be given room for more.
        pull: () => {
          if (!shouldGrant(pending.received, WINDOW_BYTES)) return;
          this.#send({ t: "window", id: message.id, bytes: pending.received });
          pending.received = 0;
        },
        cancel: () => {
          this.#requests.delete(message.id);
          pending.credit.close();
          this.#send({ t: "req-abort", id: message.id, reason: "the device stopped reading" });
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: WINDOW_BYTES }),
    );
    pending.settle(new Response(stream, { status: message.status, headers }));
  }

  // -- the devices' side ---------------------------------------------------

  /**
   * One device request, answered by the gateway. Never rejects: a gateway
   * that is asleep, slow, or gone is an HTTP status the app can show, not an
   * exception for every caller to translate.
   */
  request(request: Request, forwarded: ReadonlyArray<HeaderPair>): Promise<Response> {
    if (this.#gateway === null) {
      return Promise.resolve(
        problem(503, `the gateway ${this.#options.gatewayId} is not connected to this relay`),
      );
    }
    const id = this.#allocate();
    const url = new URL(request.url);
    const body = request.body;
    this.#send({
      t: "req",
      id,
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: [...forwardableHeaders(request.headers, true), ...forwarded],
      body: body === null ? "none" : "stream",
    });
    return new Promise<Response>((resolve) => {
      const pending: PendingRequest = {
        settle: resolve,
        credit: new Credit(WINDOW_BYTES),
        received: 0,
        timer: null,
        body: null,
        answered: false,
      };
      pending.timer = setTimeout(() => {
        this.#requests.delete(id);
        this.#send({ t: "req-abort", id, reason: "the gateway did not answer in time" });
        resolve(problem(504, "the gateway did not answer in time"));
      }, this.#options.responseTimeoutMs ?? 30_000);
      this.#requests.set(id, pending);
      if (body !== null) void this.#pump(id, body);
    });
  }

  /**
   * Asks the gateway to accept an upgrade, and waits, so a relay never hands
   * a device a 101 for a socket the gateway refused. The runtime binds its
   * own socket to the id it gets back.
   */
  upgrade(request: Request, forwarded: ReadonlyArray<HeaderPair>): Promise<UpgradeResult> {
    if (this.#gateway === null) {
      return Promise.resolve({
        ok: false,
        status: 503,
        message: `the gateway ${this.#options.gatewayId} is not connected to this relay`,
      });
    }
    const id = this.#allocate();
    const url = new URL(request.url);
    this.#send({
      t: "ws",
      id,
      url: `${url.pathname}${url.search}`,
      headers: [...forwardableHeaders(request.headers, true), ...forwarded],
    });
    return new Promise<UpgradeResult>((resolve) => {
      const pending: PendingUpgrade = { settle: resolve, timer: null };
      pending.timer = setTimeout(() => {
        this.#upgrades.delete(id);
        this.#send({ t: "ws-close", id, code: 1013, reason: "no answer" });
        resolve({ ok: false, status: 504, message: "the gateway did not accept the socket" });
      }, this.#options.upgradeTimeoutMs ?? 10_000);
      this.#upgrades.set(id, pending);
    });
  }

  /** The device's socket is open and messages for it can be delivered. */
  bindSocket(id: number, link: Link): void {
    this.#sockets.set(id, link);
    this.#binding.delete(id);
    const waiting = this.#buffered.get(id);
    this.#buffered.delete(id);
    for (const message of waiting ?? []) {
      if (message.text !== null) link.sendText(message.text);
      else if (message.bytes !== null) link.sendBinary(message.bytes);
    }
  }

  socketText(id: number, text: string): void {
    this.#sendBinary(CHANNEL.wsText, id, new TextEncoder().encode(text));
  }

  socketBinary(id: number, bytes: Uint8Array): void {
    this.#sendBinary(CHANNEL.wsBinary, id, bytes);
  }

  socketClosed(id: number, code: number, reason: string): void {
    this.#binding.delete(id);
    if (!this.#sockets.delete(id)) return;
    this.#buffered.delete(id);
    this.#send({ t: "ws-close", id, code, reason });
  }

  // -- plumbing ------------------------------------------------------------

  async #pump(id: number, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const waiting = this.#requests.get(id)?.credit.wait();
        if (waiting !== null && waiting !== undefined) await waiting;
        const chunk = await reader.read();
        if (chunk.done) break;
        const pending = this.#requests.get(id);
        if (pending === undefined) return;
        this.#sendBinary(CHANNEL.body, id, chunk.value);
        pending.credit.spend(chunk.value.byteLength);
      }
      this.#send({ t: "req-end", id });
    } catch (error) {
      this.#send({ t: "req-abort", id, reason: String(error) });
    } finally {
      reader.releaseLock();
    }
  }

  #settleUpgrade(id: number, result: UpgradeResult): void {
    const pending = this.#upgrades.get(id);
    if (pending === undefined) return;
    this.#upgrades.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (result.ok) this.#binding.add(id);
    pending.settle(result);
  }

  #clear(pending: PendingRequest): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
  }

  #allocate(): number {
    for (;;) {
      const id = this.#nextId;
      this.#nextId = this.#nextId >= 0xff_ff_ff_ff ? 1 : this.#nextId + 1;
      if (!this.#requests.has(id) && !this.#sockets.has(id) && !this.#upgrades.has(id)) return id;
    }
  }

  /** Everything that belonged to a link that is going away. */
  #reset(code: number, reason: string): void {
    for (const [id, pending] of this.#requests) {
      this.#requests.delete(id);
      this.#clear(pending);
      pending.credit.close();
      if (pending.answered) pending.body?.error(new Error(reason));
      else pending.settle(problem(502, reason));
    }
    for (const [id, pending] of this.#upgrades) {
      this.#upgrades.delete(id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.settle({ ok: false, status: 502, message: reason });
    }
    for (const [id, socket] of this.#sockets) {
      this.#sockets.delete(id);
      socket.close(code, reason);
    }
    this.#buffered.clear();
    this.#binding.clear();
  }

  #send(message: ToGateway): void {
    this.#gateway?.sendText(JSON.stringify(message));
  }

  #sendBinary(channel: 0 | 1 | 2, id: number, payload: Uint8Array): void {
    this.#gateway?.sendBinary(encodeFrame(channel, id, payload));
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }
}

/** Headers a proxy owes the origin about the client it is standing in for. */
export const forwardedHeaders = (request: Request, ip: string | null): Array<HeaderPair> => {
  const url = new URL(request.url);
  const pairs: Array<HeaderPair> = [
    ["x-forwarded-host", url.host],
    ["x-forwarded-proto", url.protocol === "https:" ? "https" : "http"],
  ];
  if (ip !== null) pairs.push(["x-forwarded-for", ip]);
  return pairs;
};
