/**
 * One suite, run against every relay we ship: the Bun process and the Worker
 * on workerd. Nothing here reaches into the tunnel's internals. Every
 * assertion is what a device on the far side of the relay would see, which is
 * the only way the two implementations can be held to the same behaviour.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Server } from "bun";
import { connect, type Connector } from "../src/connector.ts";

export const ADMIN_TOKEN = "admin-token-for-tests";
export const GATEWAY_ID = "laptop";

/** A relay that is up and answering, however it was started. */
export interface RelayUnderTest {
  readonly base: string;
  readonly stop: () => Promise<void>;
}

/** What `/firehose` has been allowed to produce, for the backpressure test. */
export const produced = { bytes: 0 };

const FIREHOSE_CHUNK = 512 * 1024;
const FIREHOSE_CHUNKS = 32;
export const FIREHOSE_TOTAL = FIREHOSE_CHUNK * FIREHOSE_CHUNKS;

/** Stands in for the gateway: an ordinary HTTP server with a socket route. */
export const startOrigin = (): Server<undefined> =>
  Bun.serve({
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === "/socket") {
        return server.upgrade(request)
          ? undefined
          : new Response("expected a socket", { status: 400 });
      }
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/missing") return new Response("nope", { status: 404 });
      if (url.pathname === "/headers") {
        return Response.json(Object.fromEntries(request.headers.entries()));
      }
      if (url.pathname === "/echo") {
        const body = await request.arrayBuffer();
        return new Response(body, {
          headers: { "content-type": "application/octet-stream", "x-method": request.method },
        });
      }
      if (url.pathname === "/firehose") {
        produced.bytes = 0;
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          // Pulled, not pushed, so the counter measures what the chain
          // downstream was willing to take rather than what a loop wrote.
          pull: (controller) => {
            if (sent === FIREHOSE_CHUNKS) {
              controller.close();
              return;
            }
            sent += 1;
            produced.bytes += FIREHOSE_CHUNK;
            controller.enqueue(new Uint8Array(FIREHOSE_CHUNK));
          },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/stream") {
        const stream = new ReadableStream<Uint8Array>({
          start: async (controller) => {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("first\n"));
            await Bun.sleep(250);
            controller.enqueue(encoder.encode("second\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      }
      return new Response(`no route for ${url.pathname}${url.search}`, { status: 418 });
    },
    websocket: {
      open: (socket) => {
        socket.send("hello");
      },
      message: (socket, message) => {
        if (ArrayBuffer.isView(message)) socket.send(message);
        else socket.send(`echo:${message}`);
      },
    },
  });

export const mintToken = async (base: string): Promise<string> => {
  const response = await fetch(`${base}/_relay/admin/gateways/${GATEWAY_ID}/credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "test" }),
  });
  if (response.status !== 201) throw new Error(`minting failed with ${response.status}`);
  const body = (await response.json()) as { token: string };
  return body.token;
};

/** Polls until the relay answers, or gives up. Workerd takes a while to boot. */
export const waitForRelay = async (base: string, deadlineMs: number): Promise<void> => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const reached = await fetch(`${base}/_relay/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (reached) return;
    if (Date.now() > until) throw new Error(`no relay answered at ${base}`);
    await Bun.sleep(250);
  }
};

export interface SuiteOptions {
  readonly name: string;
  readonly enabled: boolean;
  readonly start: () => Promise<RelayUnderTest>;
  /** Workerd needs to be spawned and compiled before anything can be asked of it. */
  readonly startupMs?: number;
}

export const relaySuite = (options: SuiteOptions): void => {
  describe.skipIf(!options.enabled)(options.name, () => {
    let origin: Server<undefined>;
    let relay: RelayUnderTest;
    let connector: Connector;
    let base: string;

    beforeAll(async () => {
      origin = startOrigin();
      relay = await options.start();
      base = relay.base;
      const token = await mintToken(base);
      const opened = Promise.withResolvers<void>();
      connector = connect({
        relay: base,
        token,
        target: `http://127.0.0.1:${origin.port}`,
        onOpen: () => {
          opened.resolve();
        },
      });
      await opened.promise;
    }, options.startupMs ?? 30_000);

    afterAll(async () => {
      connector?.close();
      await relay?.stop();
      await origin?.stop(true);
    });

    test("the relay reports the gateway as connected", async () => {
      const response = await fetch(`${base}/_relay/health`);
      expect(await response.json()).toMatchObject({ gateway: GATEWAY_ID, connected: true });
    });

    test("a device's GET reaches the gateway", async () => {
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    });

    test("the gateway's status and path are what the device sees", async () => {
      const missing = await fetch(`${base}/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("nope");

      const query = await fetch(`${base}/nowhere?a=1&b=two`);
      expect(query.status).toBe(418);
      expect(await query.text()).toBe("no route for /nowhere?a=1&b=two");
    });

    test("a request body of many frames arrives whole", async () => {
      const payload = crypto.getRandomValues(new Uint8Array(300_000));
      const response = await fetch(`${base}/echo`, { method: "POST", body: payload });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-method")).toBe("POST");
      const returned = new Uint8Array(await response.arrayBuffer());
      expect(returned.byteLength).toBe(payload.byteLength);
      expect(Bun.SHA256.hash(returned, "hex")).toBe(Bun.SHA256.hash(payload, "hex"));
    });

    test("the device's own headers reach the gateway, and the relay's replace theirs", async () => {
      const response = await fetch(`${base}/headers`, {
        headers: { authorization: "Bearer device-credential", "x-forwarded-for": "10.0.0.1" },
      });
      const headers = (await response.json()) as Record<string, string>;
      expect(headers.authorization).toBe("Bearer device-credential");
      expect(headers["x-forwarded-proto"]).toBe("http");
      expect(headers["x-forwarded-host"]).toBe(new URL(base).host);
      expect(headers["x-forwarded-for"]).not.toBe("10.0.0.1");
      expect(headers["x-relay-op"]).toBeUndefined();
      expect(headers["x-relay-gateway"]).toBeUndefined();
    });

    test("a streamed response reaches the device before it ends", async () => {
      const response = await fetch(`${base}/stream`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const started = Date.now();
      const first = await reader.read();
      const afterFirst = Date.now() - started;
      expect(decoder.decode(first.value)).toBe("first\n");
      expect(afterFirst).toBeLessThan(200);
      const second = await reader.read();
      expect(decoder.decode(second.value)).toBe("second\n");
      expect((await reader.read()).done).toBe(true);
    });

    test("a WebSocket tunnels both ways", async () => {
      const socket = new WebSocket(`${base.replace(/^http/, "ws")}/socket`);
      socket.binaryType = "arraybuffer";
      const messages: Array<string> = [];
      const third = Promise.withResolvers<void>();
      socket.addEventListener("message", (event) => {
        const data = event.data;
        messages.push(
          data instanceof ArrayBuffer ? `bytes:${new Uint8Array(data).length}` : String(data),
        );
        if (messages.length === 3) third.resolve();
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("the socket did not open")));
      });
      socket.send("ping-from-device");
      socket.send(new Uint8Array([1, 2, 3, 4]));
      await third.promise;
      expect(messages).toEqual(["hello", "echo:ping-from-device", "bytes:4"]);
      socket.close();
    });

    test("a body far larger than one window arrives whole", async () => {
      const response = await fetch(`${base}/firehose`);
      const reader = response.body!.getReader();
      let received = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
      }
      expect(received).toBe(FIREHOSE_TOTAL);
      expect(produced.bytes).toBe(FIREHOSE_TOTAL);
    });

    test("the admin API refuses an unknown token", async () => {
      const response = await fetch(`${base}/_relay/admin/gateways/${GATEWAY_ID}/credentials`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(response.status).toBe(401);
    });

    test("the admin API lists what it minted, and never a secret", async () => {
      const response = await fetch(`${base}/_relay/admin/gateways/${GATEWAY_ID}/credentials`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const body = (await response.json()) as {
        credentials: Array<{ label: string; fingerprint: string }>;
      };
      expect(body.credentials.length).toBeGreaterThanOrEqual(1);
      expect(body.credentials[0]!.label).toBe("test");
      expect(body.credentials[0]!.fingerprint).toHaveLength(12);
      expect(JSON.stringify(body)).not.toContain("mrk_");
    });

    test("a credential the relay does not know is refused", async () => {
      const refused = Promise.withResolvers<number>();
      const rejected = connect({
        relay: base,
        token: `mrk_${GATEWAY_ID}.not-a-real-secret`,
        target: `http://127.0.0.1:${origin.port}`,
        reconnect: false,
        onClose: (code) => refused.resolve(code),
      });
      expect(await refused.promise).toBeGreaterThan(0);
      rejected.close();
    });

    // Last: everything after this runs without a gateway on the far side.
    test("a device is told plainly when the gateway is not connected", async () => {
      connector.close();
      await Bun.sleep(250);
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not connected");

      const health = await fetch(`${base}/_relay/health`);
      expect(await health.json()).toMatchObject({ connected: false });
    });

    test("a gateway that comes back is serving again", async () => {
      // What a laptop waking from sleep does, with a credential already
      // minted and a relay that has been sitting there without it.
      const token = await mintToken(base);
      const opened = Promise.withResolvers<void>();
      const woken = connect({
        relay: base,
        token,
        target: `http://127.0.0.1:${origin.port}`,
        onOpen: () => {
          opened.resolve();
        },
      });
      await opened.promise;
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      woken.close();
    });
  });
};
