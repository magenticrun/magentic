import { AgentNotFound } from "@magentic/protocol";
import { Effect, Option } from "effect";
import type { GatewayClient } from "./Gateway.ts";

/** The agent named by the flag, or the first one the gateway hosts. */
export const resolveAgent = Effect.fn("Cli.resolveAgent")(function* (
  client: GatewayClient,
  wanted: Option.Option<string>,
) {
  const agents = yield* client.agents.list();
  if (Option.isSome(wanted)) {
    const found = agents.find((agent) => agent.name === wanted.value);
    return found ?? (yield* new AgentNotFound({ name: wanted.value }));
  }
  const first = agents[0];
  return first ?? (yield* new AgentNotFound({ name: "(none registered)" }));
});
