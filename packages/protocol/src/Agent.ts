import { Schema } from "effect";

/** What a surface is allowed to know about an agent. */
export class AgentInfo extends Schema.Class<AgentInfo>("magentic/protocol/AgentInfo")({
  name: Schema.NonEmptyString,
  description: Schema.String,
  tools: Schema.Array(Schema.String),
  /** The `provider/model` the agent runs on; absent when no provider answers to its configuration. */
  model: Schema.optional(Schema.String),
}) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  name: Schema.String,
}) {
  /** Without this a surface that prints `error.message` says nothing at all. */
  override get message(): string {
    return `no agent named "${this.name}"`;
  }
}
