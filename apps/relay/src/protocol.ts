/**
 * The wire between a relay and the gateway connected to it.
 *
 * One WebSocket carries every device that reaches the relay. Text frames are
 * JSON control messages; binary frames are payload, prefixed with the channel
 * and the id of the stream they belong to. The relay allocates stream ids,
 * because the relay is the only side that starts a stream: a device made an
 * HTTP request, or a device asked to upgrade.
 *
 * Nothing here knows what magentic's protocol says. The relay forwards bytes
 * and never parses an RPC, which is what lets it stay a separate component
 * from the gateway it serves.
 */

/** Bumped when a change would confuse an older connector or relay. */
export const PROTOCOL_VERSION = 1;

/**
 * How many bytes of one stream may be in flight before its writer must wait
 * for room. One window per stream, in each direction.
 */
export const WINDOW_BYTES = 1_048_576;

/** Path every relay answers the gateway's outbound connection on. */
export const CONNECT_PATH = "/_relay/connect";

/** Prefix the relay keeps for itself. Everything else is tunnelled. */
export const RESERVED_PREFIX = "/_relay/";

/**
 * Sent as a whole text frame rather than JSON so a Durable Object can answer
 * it with `setWebSocketAutoResponse` without waking from hibernation.
 */
export const PING = "ping";
export const PONG = "pong";

export const CHANNEL = {
  /** An HTTP request or response body chunk. */
  body: 0,
  /** A text message on a tunnelled WebSocket. */
  wsText: 1,
  /** A binary message on a tunnelled WebSocket. */
  wsBinary: 2,
} as const;

export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

const isChannel = (value: number): value is Channel =>
  value === CHANNEL.body || value === CHANNEL.wsText || value === CHANNEL.wsBinary;

/** Header names, lowercased, that describe one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Headers the relay writes itself. A device that sends one is either confused
 * or trying to look like the relay to the gateway, and either way its version
 * is dropped before the request is forwarded.
 */
const RELAY_OWNED = /^(?:x-relay-|x-forwarded-)/;

/** Everything the upgrade handshake owns, which the tunnel redoes itself. */
const WEBSOCKET_ONLY = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-accept",
  "sec-websocket-extensions",
]);

export type HeaderPair = readonly [string, string];

/** The headers worth forwarding, in the order the request had them. */
export const forwardableHeaders = (headers: Headers, dropWebSocket: boolean): Array<HeaderPair> => {
  const out: Array<HeaderPair> = [];
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    if (RELAY_OWNED.test(key)) return;
    if (dropWebSocket && WEBSOCKET_ONLY.has(key)) return;
    out.push([key, value]);
  });
  return out;
};

/** Rebuilds a `Headers` from the pairs, keeping repeated names (`set-cookie`). */
export const headersFrom = (pairs: ReadonlyArray<HeaderPair>): Headers => {
  const headers = new Headers();
  for (const [name, value] of pairs) headers.append(name, value);
  return headers;
};

/** Control messages the relay sends to the gateway. */
export type ToGateway =
  | {
      readonly t: "hello";
      readonly protocol: number;
      readonly gatewayId: string;
      readonly relay: string;
    }
  | {
      readonly t: "req";
      readonly id: number;
      readonly method: string;
      readonly url: string;
      readonly headers: ReadonlyArray<HeaderPair>;
      readonly body: "none" | "stream";
    }
  | { readonly t: "req-end"; readonly id: number }
  | { readonly t: "req-abort"; readonly id: number; readonly reason: string }
  /** Room for this many more bytes of the response body. */
  | { readonly t: "window"; readonly id: number; readonly bytes: number }
  | {
      readonly t: "ws";
      readonly id: number;
      readonly url: string;
      readonly headers: ReadonlyArray<HeaderPair>;
    }
  | { readonly t: "ws-close"; readonly id: number; readonly code: number; readonly reason: string };

/** Control messages the gateway sends back. */
export type FromGateway =
  | { readonly t: "hello"; readonly protocol: number; readonly agent: string }
  | {
      readonly t: "res";
      readonly id: number;
      readonly status: number;
      readonly headers: ReadonlyArray<HeaderPair>;
      readonly body: "none" | "stream";
    }
  | { readonly t: "res-end"; readonly id: number }
  /** Room for this many more bytes of the request body. */
  | { readonly t: "window"; readonly id: number; readonly bytes: number }
  | {
      readonly t: "res-error";
      readonly id: number;
      readonly status: number;
      readonly message: string;
    }
  | { readonly t: "ws-open"; readonly id: number; readonly protocol: string | null }
  | {
      readonly t: "ws-reject";
      readonly id: number;
      readonly status: number;
      readonly message: string;
    }
  | { readonly t: "ws-close"; readonly id: number; readonly code: number; readonly reason: string };

const HEADER_BYTES = 5;

/** `[channel][stream id][payload]`, the only shape a binary frame takes. */
export const encodeFrame = (channel: Channel, id: number, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = channel;
  new DataView(frame.buffer).setUint32(1, id >>> 0, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
};

export interface Frame {
  readonly channel: Channel;
  readonly id: number;
  readonly payload: Uint8Array;
}

export const decodeFrame = (data: Uint8Array): Frame | null => {
  if (data.byteLength < HEADER_BYTES) return null;
  const channel = data[0];
  if (channel === undefined || !isChannel(channel)) return null;
  const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false);
  return { channel, id, payload: data.subarray(HEADER_BYTES) };
};

/**
 * Control frames come from an authenticated peer, but a peer at the wrong
 * version or with a bug is still a peer, so a message that is not one of ours
 * becomes `null` rather than an exception in a socket handler.
 */
export const parseControl = <T extends { readonly t: string }>(text: string): T | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  return value as T;
};

/** What a socket handed us, however this runtime spells "some bytes". */
export const toBytes = (data: string | ArrayBuffer | ArrayBufferView): Uint8Array =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new TextEncoder().encode(data);
