import { Schema } from "effect";

/** Ask an agent to handle one input, optionally continuing an earlier conversation. */
export const RunRequest = Schema.Struct({
  input: Schema.NonEmptyString,
  conversationId: Schema.optional(Schema.String),
  /** A `provider/model` reference to run on instead of the agent's own. */
  model: Schema.optional(Schema.String),
});
export type RunRequest = typeof RunRequest.Type;

export const RunStarted = Schema.TaggedStruct("RunStarted", {
  runId: Schema.String,
  /** Send this back with the next input to keep the history. */
  conversationId: Schema.String,
});
export const TextDelta = Schema.TaggedStruct("TextDelta", { text: Schema.String });
export const ReasoningDelta = Schema.TaggedStruct("ReasoningDelta", { text: Schema.String });
export const ToolCall = Schema.TaggedStruct("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
});
export const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  name: Schema.String,
  result: Schema.Json,
  isFailure: Schema.Boolean,
});
export const RunFinished = Schema.TaggedStruct("RunFinished", { reason: Schema.String });
export const RunFailed = Schema.TaggedStruct("RunFailed", { message: Schema.String });

/** What a surface sees while an agent works. Streamed over SSE. */
export const RunEvent = Schema.Union([
  RunStarted,
  TextDelta,
  ReasoningDelta,
  ToolCall,
  ToolResult,
  RunFinished,
  RunFailed,
]);
export type RunEvent = typeof RunEvent.Type;

export class RunDenied extends Schema.TaggedError<RunDenied>()(
  "RunDenied",
  { agent: Schema.String, reason: Schema.String },
  { httpApiStatus: 403 },
) {}
