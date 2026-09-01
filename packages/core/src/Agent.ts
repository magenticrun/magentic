import { Schema } from "effect";

export class ToolDefinition extends Schema.Class<ToolDefinition>("magentic/core/ToolDefinition")({
  name: Schema.NonEmptyString,
  description: Schema.String,
}) {}

export class AgentDefinition extends Schema.Class<AgentDefinition>("magentic/core/AgentDefinition")(
  {
    /** Stable identifier used in routing and policy, e.g. "support-triage". */
    name: Schema.NonEmptyString,
    description: Schema.String,
    /** Tools this agent may request. Policy still gates actual use. */
    tools: Schema.Array(Schema.String),
  },
) {}

export class AgentAlreadyRegistered extends Schema.TaggedError<AgentAlreadyRegistered>()(
  "AgentAlreadyRegistered",
  { name: Schema.String },
) {}
