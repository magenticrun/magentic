import { describe, expect, test } from "vitest";
import { serve } from "../src/bun.ts";
import { CHANNEL, encodeFrame, WINDOW_BYTES } from "../src/protocol.ts";
import { Tunnel, type Link } from "../src/tunnel.ts";
import { fileStore } from "../src/store.ts";
import { ADMIN_TOKEN, GATEWAY_ID, relaySuite } from "./relay-suite.ts";

relaySuite({
  name: "the relay as a Bun process",
  enabled: true,
  start: async () => {
    const storePath = `${Bun.env.TMPDIR ?? "/tmp"}/magentic-relay-${crypto.randomUUID()}.json`;
    const relay = serve({
      port: 0,
      hostname: "127.0.0.1",
      store: fileStore(storePath),
      adminToken: ADMIN_TOKEN,
      defaultGateway: GATEWAY_ID,
    });
    return {
      base: relay.server.url.origin,
      stop: async () => {
        await relay.stop();
        await Bun.file(storePath)
          .delete()
          .catch(() => undefined);
      },
    };
  },
});

/**
 * The send window, measured where it happens. End to end the number is
 * swamped by everyone else's buffers — Bun's fetch, wrangler's dev proxy — so
 * this drives the tunnel directly and asserts on what it puts on the wire.
 */
describe("the send window", () => {
  const CHUNK = 256 * 1024;
  const PER_WINDOW = WINDOW_BYTES / CHUNK;

  interface Control {
    readonly t: string;
    readonly id?: number;
    readonly bytes?: number;
  }

  const start = () => {
    const sent: Array<string> = [];
    const bytes: Array<Uint8Array> = [];
    const link: Link = {
      sendText: (data) => {
        sent.push(data);
      },
      sendBinary: (data) => {
        bytes.push(data);
      },
      close: () => undefined,
    };
    const tunnel = new Tunnel({ gatewayId: "test", relay: "test" });
    tunnel.attachGateway(link);
    const control = (): Array<Control> => sent.map((line) => JSON.parse(line) as Control);
    const id = (): number => {
      const req = control().find((message) => message.t === "req");
      expect(req?.id).toBeDefined();
      return req!.id!;
    };
    return { tunnel, control, bytes, id };
  };

  test("the gateway is given no more room while the device is not reading", async () => {
    const { tunnel, control, id: idOf } = start();
    const pending = tunnel.request(new Request("http://relay.test/big"), []);
    const id = idOf();
    tunnel.gatewayText(JSON.stringify({ t: "res", id, status: 200, headers: [], body: "stream" }));
    const response = await pending;

    const grants = () => control().filter((message) => message.t === "window");
    // One window's worth, which is all a gateway is allowed to send unasked.
    for (let i = 0; i < PER_WINDOW; i++) {
      tunnel.gatewayBinary(encodeFrame(CHANNEL.body, id, new Uint8Array(CHUNK)));
    }
    expect(grants()).toEqual([]);

    const reader = response.body!.getReader();
    await reader.read();
    await Bun.sleep(10);
    expect(grants().length).toBeGreaterThan(0);
    expect(grants()[0]!.bytes).toBeGreaterThanOrEqual(WINDOW_BYTES / 2);
    await reader.cancel();
  });

  test("the device's upload stops at one window until the gateway makes room", async () => {
    const { tunnel, bytes, id: idOf } = start();
    const source = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (let i = 0; i < PER_WINDOW * 6; i++) controller.enqueue(new Uint8Array(CHUNK));
        controller.close();
      },
    });
    void tunnel.request(
      new Request("http://relay.test/upload", {
        method: "POST",
        body: source,
        duplex: "half",
      } as RequestInit),
      [],
    );
    const id = idOf();
    await Bun.sleep(50);
    expect(bytes.length).toBe(PER_WINDOW);

    tunnel.gatewayText(JSON.stringify({ t: "window", id, bytes: WINDOW_BYTES }));
    await Bun.sleep(50);
    expect(bytes.length).toBe(PER_WINDOW * 2);
  });
});
