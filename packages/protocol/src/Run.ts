import { Schema } from "effect";
import { ConversationId } from "./ConversationId.ts";

/** A file sent along with the input, such as an image pasted into a chat. */
export const Attachment = Schema.Struct({
  mediaType: Schema.String,
  /** The bytes; base64 on the wire. */
  data: Schema.Uint8ArrayFromBase64,
  fileName: Schema.optional(Schema.String),
});
export type Attachment = typeof Attachment.Type;

/** Ask an agent to handle one input, optionally continuing an earlier conversation. */
export const RunRequest = Schema.Struct({
  input: Schema.NonEmptyString,
  attachments: Schema.optional(Schema.Array(Attachment)),
  conversationId: Schema.optional(ConversationId),
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
  system: Schema.Finite,
  tools: Schema.Finite,
  toolCount: Schema.Finite,
  user: Schema.Finite,
  assistant: Schema.Finite,
  toolCalls: Schema.Finite,
  messages: Schema.Finite,
});
export type ContextBreakdown = typeof ContextBreakdown.Type;

/**
 * What the latest model call cost, once per call. The input is the whole
 * conversation so far, cached or not, so input plus output is the context in
 * use. The finer counts are absent when the provider does not report them.
 */
export const TokenUsage = Schema.TaggedStruct("TokenUsage", {
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  /** Input served from the provider's prompt cache; part of `inputTokens`. */
  cacheReadTokens: Schema.optional(Schema.Finite),
  /** Input written to the prompt cache this call; part of `inputTokens`. */
  cacheWriteTokens: Schema.optional(Schema.Finite),
  /** Output spent thinking; part of `outputTokens`. */
  reasoningTokens: Schema.optional(Schema.Finite),
  breakdown: ContextBreakdown,
});
export type TokenUsage = typeof TokenUsage.Type;
/** The context neared the model's window; a summary is being written. */
export const CompactionStarted = Schema.TaggedStruct("CompactionStarted", {});
/** The conversation so far was folded into a summary the model continues from. */
export const Compacted = Schema.TaggedStruct("Compacted", {
  summary: Schema.String,
  /** Messages the model saw before, and after; the system prompt included. */
  messagesBefore: Schema.Finite,
  messagesAfter: Schema.Finite,
});
export type Compacted = typeof Compacted.Type;
/** A model call failed in a way worth another try; the next one comes after `delayMs`. */
export const Retrying = Schema.TaggedStruct("Retrying", {
  /** This is the nth retry, of at most `limit`. */
  attempt: Schema.Finite,
  limit: Schema.Finite,
  message: Schema.String,
  delayMs: Schema.Finite,
});
export type Retrying = typeof Retrying.Type;
/**
 * The model's finish reason (`stop`, `tool-calls`, `length`, …), or
 * `step-limit` when the run stopped at the agent's step limit, tool results
 * still in the history for the next input to continue from.
 */
export const RunFinished = Schema.TaggedStruct("RunFinished", { reason: Schema.String });
export const RunFailed = Schema.TaggedStruct("RunFailed", { message: Schema.String });

/** What a surface sees while an agent works. Streamed from the `run` RPC. */
export const RunEvent = Schema.Union([
  RunStarted,
  TextDelta,
  ReasoningDelta,
  ToolCall,
  ToolResult,
  TokenUsage,
  CompactionStarted,
  Compacted,
  Retrying,
  RunFinished,
  RunFailed,
]);
export type RunEvent = typeof RunEvent.Type;

export class RunDenied extends Schema.TaggedError<RunDenied>()("RunDenied", {
  agent: Schema.String,
  reason: Schema.String,
}) {}
