import { describeCause } from "@magentic/core";
import type { Conversation } from "@magentic/protocol";
import { Cause, Effect, Option, Schema } from "effect";
import { resolveAgent } from "./Agents.ts";
import type { GatewayClient } from "./Gateway.ts";

/** What the chat and the one-shot run share of their flags: which agent, and which conversation to pick up. */
export interface PickUpOptions {
  readonly agent: Option.Option<string>;
  /** Pick up the most recent conversation, of the agent when one is named. */
  readonly continue: boolean;
  /** Pick up this conversation. */
  readonly session: Option.Option<string>;
}

/** The conversation asked for cannot be picked up, in words for the terminal. */
class ResumeError extends Schema.TaggedError<ResumeError>()("ResumeError", {
  message: Schema.String,
}) {}

/**
 * The conversation the flags ask to pick up: the one named, or the newest
 * (of the agent, when one is named). None when nothing was asked, or nothing
 * is there yet to continue.
 */
const startingConversation = Effect.fn("Cli.startingConversation")(function* (
  client: GatewayClient,
  options: PickUpOptions,
) {
  if (Option.isSome(options.session)) {
    const id = options.session.value;
    return Option.some(
      yield* client
        .getConversation({ id })
        .pipe(Effect.mapError(() => new ResumeError({ message: `no conversation ${id}` }))),
    );
  }
  if (!options.continue) {
    return Option.none<Conversation>();
  }
  const all = yield* client
    .listConversations({
      agent: Option.getOrUndefined(options.agent),
      directory: process.cwd(),
    })
    .pipe(
      Effect.mapError((error) => new ResumeError({ message: describeCause(Cause.fail(error)) })),
    );
  return Option.fromNullishOr(all[0]);
});

/**
 * The agent to talk to and, when the flags ask, the conversation to carry on
 * with it: the agent named, else the conversation's, else the first the
 * gateway hosts. A named conversation with some other agent is refused.
 */
export const pickUp = Effect.fn("Cli.pickUp")(function* (
  client: GatewayClient,
  options: PickUpOptions,
) {
  const starting = yield* startingConversation(client, options);
  const agent = yield* resolveAgent(
    client,
    Option.orElse(options.agent, () => Option.map(starting, (c) => c.agent)),
  );
  if (Option.isSome(starting) && starting.value.agent !== agent.name) {
    return yield* new ResumeError({
      message: `conversation ${starting.value.id} is with ${starting.value.agent}, not ${agent.name}`,
    });
  }
  return { agent, starting };
});
