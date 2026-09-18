#!/usr/bin/env bun
/**
 * Runs the gateway's end of the tunnel beside a gateway that does not yet
 * dial out on its own, the way `cloudflared` runs beside a web server.
 */

import { connect } from "../src/connector.ts";

const flag = (name: string): string | null => {
  const index = Bun.argv.indexOf(`--${name}`);
  if (index >= 0) return Bun.argv[index + 1] ?? null;
  const inline = Bun.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 3);
};

const relay = flag("relay") ?? Bun.env.MAGENTIC_RELAY_URL ?? null;
const token = flag("token") ?? Bun.env.MAGENTIC_RELAY_TOKEN ?? null;
const target = flag("target") ?? Bun.env.MAGENTIC_GATEWAY_URL ?? "http://127.0.0.1:4321";

if (relay === null || token === null) {
  console.error(
    "usage: bun run bin/connect.ts --relay https://relay.example.com --token mrk_... [--target http://127.0.0.1:4321]",
  );
  console.error(
    "       MAGENTIC_RELAY_URL, MAGENTIC_RELAY_TOKEN, and MAGENTIC_GATEWAY_URL work too",
  );
  process.exit(2);
}

const connector = connect({
  relay,
  token,
  target,
  onLog: (line) => {
    console.log(line);
  },
  onOpen: () => {
    console.log(`forwarding ${relay} to ${target}`);
  },
});

const stop = (): void => {
  connector.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
