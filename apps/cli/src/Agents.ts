import { AgentNotFound } from "@magentic/protocol";
import { Effect, Option, Schema } from "effect";
import type { GatewayClient } from "./Gateway.ts";

/** The gateway hosts nothing to talk to, which is not the same as a name it does not know. */
class NoAgents extends Schema.TaggedError<NoAgents>()("NoAgents", {
  message: Schema.String,
}) {}

/** The agent named by the flag, or the first one the gateway hosts. */
export const resolveAgent = Effect.fn("Cli.resolveAgent")(function* (
  client: GatewayClient,
  wanted: Option.Option<string>,
) {
  const agents = yield* client.listAgents();
  if (Option.isSome(wanted)) {
    const found = agents.find((agent) => agent.name === wanted.value);
    return found ?? (yield* new AgentNotFound({ name: wanted.value }));
  }
  const first = agents[0];
  return first ?? (yield* new NoAgents({ message: "the gateway hosts no agents" }));
});
