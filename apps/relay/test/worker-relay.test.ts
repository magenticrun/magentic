/**
 * The same suite against the Worker, on the real workerd runtime with real
 * Durable Objects. Cloudflare is where this relay is meant to run, so the
 * hibernation-shaped code path is the one that most needs a test. Set
 * `RELAY_SKIP_WORKER=1` to skip it, and note it takes a while to boot.
 */

import { rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_TOKEN, GATEWAY_ID, relaySuite, waitForRelay } from "./relay-suite.ts";

const relayDir = fileURLToPath(new URL("../", import.meta.url));
const wrangler = `${relayDir}node_modules/wrangler/wrangler-dist/cli.js`;
// Bun's --bun runner puts a node shim first on PATH. Wrangler needs real Node.
const node = (Bun.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "node"))
  .find((path) => existsSync(path) && basename(realpathSync(path)) === "node");
const enabled = Bun.env.RELAY_SKIP_WORKER !== "1";

/** A port nothing else is on, released before wrangler is told to take it. */
const freePort = (): string => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.url.port;
  probe.stop(true);
  return port;
};

relaySuite({
  name: "the relay as a Worker on workerd",
  enabled,
  startupMs: 120_000,
  start: async () => {
    if (node === undefined)
      throw new Error("The Worker integration suite requires Node.js for Wrangler.");
    const port = freePort();
    const state = `${Bun.env.TMPDIR ?? "/tmp"}/magentic-relay-workerd-${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        node,
        wrangler,
        "dev",
        "--port",
        port,
        "--local-upstream",
        `127.0.0.1:${port}`,
        "--inspector-port",
        freePort(),
        "--persist-to",
        state,
        "--var",
        `RELAY_ADMIN_TOKEN:${ADMIN_TOKEN}`,
        "--var",
        `RELAY_GATEWAY:${GATEWAY_ID}`,
      ],
      { cwd: relayDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForRelay(base, 20_000);
    } catch (error) {
      child.kill();
      await child.exited;
      await rm(state, { recursive: true, force: true });
      throw new Error(
        `${String(error)}\n${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`,
        { cause: error },
      );
    }
    return {
      base,
      stop: async () => {
        child.kill();
        await child.exited;
        await rm(state, { recursive: true, force: true });
      },
    };
  },
});
