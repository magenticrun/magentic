import { Schema } from "effect";

/** Ask an agent to handle one input, optionally continuing an earlier conversation. */
export const RunRequest = Schema.Struct({
  input: Schema.NonEmptyString,
  conversationId: Schema.optional(Schema.String),
  /** A `provider/model` reference to run on instead of the agent's own. */
  model: Schema.optional(Schema.String),
  /** Where the surface is working; conversations are listed by it. */
  directory: Schema.optional(Schema.String),
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
/**
 * Where the context goes, estimated at four characters a token from what the
 * runner sent, since providers report one total. `toolCalls` covers the
 * calls' arguments and results.
 */
export const ContextBreakdown = Schema.Struct({
  system: Schema.Number,
  tools: Schema.Number,
  toolCount: Schema.Number,
  user: Schema.Number,
  assistant: Schema.Number,
  toolCalls: Schema.Number,
  messages: Schema.Number,
});
export type ContextBreakdown = typeof ContextBreakdown.Type;

/**
 * What the latest model call cost, once per call. The input is the whole
 * conversation so far, cached or not, so input plus output is the context in
 * use. The finer counts are absent when the provider does not report them.
 */
export const TokenUsage = Schema.TaggedStruct("TokenUsage", {
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** Input served from the provider's prompt cache; part of `inputTokens`. */
  cacheReadTokens: Schema.optional(Schema.Number),
  /** Input written to the prompt cache this call; part of `inputTokens`. */
  cacheWriteTokens: Schema.optional(Schema.Number),
  /** Output spent thinking; part of `outputTokens`. */
  reasoningTokens: Schema.optional(Schema.Number),
  breakdown: ContextBreakdown,
});
export type TokenUsage = typeof TokenUsage.Type;
export const RunFinished = Schema.TaggedStruct("RunFinished", { reason: Schema.String });
export const RunFailed = Schema.TaggedStruct("RunFailed", { message: Schema.String });

/** What a surface sees while an agent works. Streamed over SSE. */
export const RunEvent = Schema.Union([
  RunStarted,
  TextDelta,
  ReasoningDelta,
  ToolCall,
  ToolResult,
  TokenUsage,
  RunFinished,
  RunFailed,
]);
export type RunEvent = typeof RunEvent.Type;

export class RunDenied extends Schema.TaggedError<RunDenied>()(
  "RunDenied",
  { agent: Schema.String, reason: Schema.String },
  { httpApiStatus: 403 },
) {}
