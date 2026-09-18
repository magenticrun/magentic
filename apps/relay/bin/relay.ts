#!/usr/bin/env bun
/**
 * Runs the relay as one Bun process. On Cloudflare this file is not used;
 * `wrangler deploy` publishes `src/worker.ts` instead.
 */

import { serve } from "../src/bun.ts";
import { fileStore } from "../src/store.ts";

const port = Number(Bun.env.PORT ?? "8787");
const adminToken = Bun.env.RELAY_ADMIN_TOKEN ?? null;
const store = fileStore(Bun.env.RELAY_STORE ?? "./relay-credentials.json");

if (adminToken === null) {
  console.warn(
    "RELAY_ADMIN_TOKEN is not set; the admin API is disabled and no credential can be minted",
  );
}

const relay = serve({
  port,
  hostname: Bun.env.RELAY_HOST ?? "0.0.0.0",
  store,
  adminToken,
  zone: Bun.env.RELAY_ZONE ?? null,
  defaultGateway: Bun.env.RELAY_GATEWAY ?? null,
  onLog: (line) => {
    console.log(line);
  },
});

console.log(`relay listening on ${relay.server.url.origin}`);

const stop = (): void => {
  void relay.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
