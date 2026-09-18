/**
 * The gateway's end of the tunnel.
 *
 * Core magentic's part of the relay contract is one outbound connection: dial
 * the relay, keep it up through sleep and network changes, and serve the
 * gateway's ordinary protocol over it. Until the gateway does that itself,
 * this runs beside it and does exactly that, the way `cloudflared` runs beside
 * a web server. It has no idea what magentic's protocol says; it forwards to
 * whatever HTTP server it was pointed at, so the gateway needs no change to
 * be reachable through a relay.
 */

import {
  CHANNEL,
  CONNECT_PATH,
  decodeFrame,
  encodeFrame,
  forwardableHeaders,
  headersFrom,
  parseControl,
  PING,
  PONG,
  PROTOCOL_VERSION,
  toBytes,
  WINDOW_BYTES,
  type FromGateway,
  type HeaderPair,
  type ToGateway,
} from "./protocol.ts";
import { Credit, shouldGrant } from "./credit.ts";

export const CONNECTOR_AGENT = "magentic-relay-connector/0.1.0";

export interface ConnectorOptions {
  /** The relay's base URL: `https://relay.example.com` or `wss://…`. */
  readonly relay: string;
  /** The credential the operator minted at the relay. */
  readonly token: string;
  /** The gateway to forward to: `http://127.0.0.1:4321`. */
  readonly target: string;
  /** Off in tests that want one attempt; on for a long-lived connector. */
  readonly reconnect?: boolean;
  /** Restrict tunnel requests before opening a local connection. */
  readonly allowRequest?: (path: string, upgrade: boolean) => boolean;
  readonly keepaliveMs?: number;
  readonly onLog?: (line: string) => void;
  readonly onOpen?: () => void;
  readonly onClose?: (code: number, reason: string) => void;
}

export interface Connector {
  readonly close: () => void;
}

interface InFlight {
  readonly abort: AbortController;
  /** Room left to send the response body back to the device. */
  readonly credit: Credit;
  /** Request bytes taken in since the relay was last granted room. */
  received: number;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  bodyDone: boolean;
}

/**
 * `fetch` already decoded the body, so the encoding header would lie and the
 * length it described is the length of bytes nobody will see. Without an
 * encoding, though, the length still describes exactly what we forward, and
 * it is worth keeping: a response the relay can size is a response it knows
 * is not a stream.
 */
const responseHeaders = (headers: Headers): Array<HeaderPair> => {
  const pairs = forwardableHeaders(headers, true).filter(([name]) => name !== "content-encoding");
  const length = headers.get("content-length");
  if (length !== null && headers.get("content-encoding") === null) {
    pairs.push(["content-length", length]);
  }
  return pairs;
};

const socketUrl = (relay: string): string => {
  const url = new URL(CONNECT_PATH, relay);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.toString();
};

const backoffFor = (attempt: number): number => {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return base / 2 + Math.random() * (base / 2);
};

export const connect = (options: ConnectorOptions): Connector => {
  const log = options.onLog ?? (() => undefined);
  const target = new URL(options.target);
  let stopped = false;
  let socket: WebSocket | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const requests = new Map<number, InFlight>();
  const sockets = new Map<number, WebSocket>();

  const send = (message: FromGateway): void => {
    socket?.send(JSON.stringify(message));
  };

  const sendBytes = (channel: 0 | 1 | 2, id: number, payload: Uint8Array): void => {
    socket?.send(new Uint8Array(encodeFrame(channel, id, payload)));
  };

  const cleanup = (): void => {
    for (const [id, flight] of requests) {
      requests.delete(id);
      flight.credit.close();
      flight.abort.abort();
    }
    for (const [id, local] of sockets) {
      sockets.delete(id);
      local.close(1001, "relay connection lost");
    }
  };

  const handleRequest = async (message: Extract<ToGateway, { t: "req" }>): Promise<void> => {
    const abort = new AbortController();
    const flight: InFlight = {
      abort,
      credit: new Credit(WINDOW_BYTES),
      received: 0,
      body: null,
      bodyDone: false,
    };
    let body: ReadableStream<Uint8Array> | null = null;
    if (message.body === "stream") {
      body = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            flight.body = controller;
          },
          // Called whenever the gateway has read the queue back below the
          // window: the moment the relay can be given room for more.
          pull: () => {
            if (!shouldGrant(flight.received, WINDOW_BYTES)) return;
            send({ t: "window", id: message.id, bytes: flight.received });
            flight.received = 0;
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: WINDOW_BYTES }),
      );
    }
    requests.set(message.id, flight);
    const url = new URL(message.url, target);
    if (url.origin !== target.origin || options.allowRequest?.(url.pathname, false) === false) {
      requests.delete(message.id);
      send({ t: "res-error", id: message.id, status: 403, message: "route unavailable" });
      return;
    }
    try {
      const response = await fetch(url, {
        method: message.method,
        headers: headersFrom(message.headers),
        body,
        signal: abort.signal,
        redirect: "manual",
        // Streaming a request body is opt-in; without it the runtime waits
        // for a body the relay is still forwarding.
        duplex: "half",
      } as RequestInit);
      if (!requests.has(message.id)) return;
      const stream = response.body;
      send({
        t: "res",
        id: message.id,
        status: response.status,
        headers: responseHeaders(response.headers),
        body: stream === null ? "none" : "stream",
      });
      if (stream === null) {
        requests.delete(message.id);
        send({ t: "res-end", id: message.id });
        return;
      }
      const reader = stream.getReader();
      for (;;) {
        const waiting = flight.credit.wait();
        if (waiting !== null) await waiting;
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!requests.has(message.id)) {
          await reader.cancel();
          return;
        }
        sendBytes(CHANNEL.body, message.id, chunk.value);
        flight.credit.spend(chunk.value.byteLength);
      }
      requests.delete(message.id);
      send({ t: "res-end", id: message.id });
    } catch (error) {
      requests.delete(message.id);
      if (abort.signal.aborted) return;
      log(`request ${message.method} ${message.url} failed: ${String(error)}`);
      send({
        t: "res-error",
        id: message.id,
        status: 502,
        message: `the gateway at ${target.origin} could not be reached: ${String(error)}`,
      });
    }
  };

  const handleUpgrade = (message: Extract<ToGateway, { t: "ws" }>): void => {
    const url = new URL(message.url, target);
    if (url.origin !== target.origin || options.allowRequest?.(url.pathname, true) === false) {
      send({ t: "ws-reject", id: message.id, status: 403, message: "route unavailable" });
      return;
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const headers = new Headers();
    let protocols: string | undefined;
    for (const [name, value] of message.headers) {
      if (name === "sec-websocket-protocol") protocols = value;
      else headers.append(name, value);
    }
    let local: WebSocket;
    try {
      local = new WebSocket(url, { headers, protocols } as unknown as string);
    } catch (error) {
      send({ t: "ws-reject", id: message.id, status: 502, message: String(error) });
      return;
    }
    local.binaryType = "arraybuffer";
    let opened = false;
    let refused = false;
    const refuse = (): void => {
      if (opened || refused) return;
      refused = true;
      sockets.delete(message.id);
      send({ t: "ws-reject", id: message.id, status: 502, message: "the gateway refused" });
    };
    local.addEventListener("open", () => {
      opened = true;
      sockets.set(message.id, local);
      send({
        t: "ws-open",
        id: message.id,
        protocol: local.protocol === "" ? null : local.protocol,
      });
    });
    local.addEventListener("message", (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        sendBytes(CHANNEL.wsBinary, message.id, toBytes(data));
      } else {
        sendBytes(CHANNEL.wsText, message.id, toBytes(String(data)));
      }
    });
    local.addEventListener("close", (event) => {
      if (!opened) {
        refuse();
        return;
      }
      sockets.delete(message.id);
      send({ t: "ws-close", id: message.id, code: event.code, reason: event.reason });
    });
    local.addEventListener("error", refuse);
  };

  const dispatch = (message: ToGateway): void => {
    switch (message.t) {
      case "hello": {
        log(`connected to ${message.relay} as gateway ${message.gatewayId}`);
        send({ t: "hello", protocol: PROTOCOL_VERSION, agent: CONNECTOR_AGENT });
        options.onOpen?.();
        return;
      }
      case "req": {
        void handleRequest(message);
        return;
      }
      case "req-end": {
        const flight = requests.get(message.id);
        if (flight === undefined || flight.bodyDone) return;
        flight.bodyDone = true;
        flight.body?.close();
        return;
      }
      case "req-abort": {
        const flight = requests.get(message.id);
        requests.delete(message.id);
        flight?.credit.close();
        flight?.abort.abort();
        return;
      }
      case "window": {
        requests.get(message.id)?.credit.grant(message.bytes);
        return;
      }
      case "ws": {
        handleUpgrade(message);
        return;
      }
      case "ws-close": {
        const local = sockets.get(message.id);
        sockets.delete(message.id);
        local?.close(message.code === 1005 ? 1000 : message.code, message.reason);
        return;
      }
    }
  };

  const onBinary = (data: Uint8Array): void => {
    const frame = decodeFrame(data);
    if (frame === null) return;
    if (frame.channel === CHANNEL.body) {
      const flight = requests.get(frame.id);
      if (flight?.body === undefined || flight.body === null) return;
      flight.received += frame.payload.byteLength;
      flight.body.enqueue(new Uint8Array(frame.payload));
      return;
    }
    const local = sockets.get(frame.id);
    if (local === undefined || local.readyState !== WebSocket.OPEN) return;
    if (frame.channel === CHANNEL.wsText) local.send(new TextDecoder().decode(frame.payload));
    else local.send(new Uint8Array(frame.payload));
  };

  const open = (): void => {
    if (stopped) return;
    const next = new WebSocket(socketUrl(options.relay), {
      headers: { authorization: `Bearer ${options.token}` },
    } as unknown as string);
    socket = next;
    next.binaryType = "arraybuffer";
    next.addEventListener("open", () => {
      attempt = 0;
      keepalive = setInterval(() => {
        if (next.readyState === WebSocket.OPEN) next.send(PING);
      }, options.keepaliveMs ?? 30_000);
    });
    next.addEventListener("message", (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        onBinary(toBytes(data));
        return;
      }
      const text = String(data);
      if (text === PING) {
        next.send(PONG);
        return;
      }
      if (text === PONG) return;
      const message = parseControl<ToGateway>(text);
      if (message === null) {
        log("ignored an unreadable control frame from the relay");
        return;
      }
      dispatch(message);
    });
    next.addEventListener("close", (event) => {
      if (keepalive !== null) clearInterval(keepalive);
      keepalive = null;
      socket = null;
      cleanup();
      options.onClose?.(event.code, event.reason);
      if (event.code === 4401) {
        log("the relay rejected the credential; not retrying");
        return;
      }
      if (stopped || options.reconnect === false) return;
      const wait = backoffFor(attempt++);
      log(`relay connection closed (${event.code}); reconnecting in ${Math.round(wait)}ms`);
      retry = setTimeout(open, wait);
    });
    next.addEventListener("error", () => {
      log(`could not reach the relay at ${options.relay}`);
    });
  };

  open();

  return {
    close: () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      if (keepalive !== null) clearInterval(keepalive);
      cleanup();
      socket?.close(1000, "connector stopped");
      socket = null;
    },
  };
};
