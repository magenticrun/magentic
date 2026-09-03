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
  /**
   * How hard the model should think: one of its `reasoningLevels`. Absent
   * means the provider's default.
   */
  reasoning: Schema.optional(Schema.String),
});
export type RunRequest = typeof RunRequest.Type;

/**
 * More for a run in flight: appended to the conversation and shown to the
 * model at its next call, before it speaks again, without waiting for the
 * run to end. What arrives while the model is speaking waits for its next
 * call; what arrives after it has answered starts another.
 */
export const SteerRequest = Schema.Struct({
  runId: Schema.String,
  input: Schema.NonEmptyString,
  attachments: Schema.optional(Schema.Array(Attachment)),
});
export type SteerRequest = typeof SteerRequest.Type;

/**
 * Follow a conversation: the runs the gateway starts in it on its own go to
 * the follower, on the agent named here and the model the conversation last
 * ran on, thinking as hard as the follower's own runs do.
 */
export const FollowRequest = Schema.Struct({
  conversationId: ConversationId,
  agent: Schema.String,
  /** How hard the model should think in those runs; absent means the provider's default. */
  reasoning: Schema.optional(Schema.String),
});
export type FollowRequest = typeof FollowRequest.Type;

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
 * Inputs steered into the run reached the model: they are one user message
 * in the history now, and the next model call sees them.
 */
export const Steered = Schema.TaggedStruct("Steered", { inputs: Schema.Array(Schema.String) });
export type Steered = typeof Steered.Type;
/**
 * Notices from the harness reached the model, a background command's end
 * for one: they are one user message in the history now, marked as not the
 * person's, and the next model call sees them.
 */
export const Notified = Schema.TaggedStruct("Notified", { notices: Schema.Array(Schema.String) });
export type Notified = typeof Notified.Type;
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
  model: Schema.optional(Schema.String),
  /** Input served from the provider's prompt cache; part of `inputTokens`. */
  cacheReadTokens: Schema.optional(Schema.Finite),
  /** Input written to the prompt cache this call; part of `inputTokens`. */
  cacheWriteTokens: Schema.optional(Schema.Finite),
  /** Output spent thinking; part of `outputTokens`. */
  reasoningTokens: Schema.optional(Schema.Finite),
  /** What the call cost in US dollars at the catalog's prices; absent when the model has none listed. */
  cost: Schema.optional(Schema.Finite),
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
 * still in the history for the next input to continue from, or
 * `interrupted` when the surface stopped it, what the model said so far
 * kept the same way. A run the gateway started on its own ends the same
 * ways; one that found nothing to say emits no events at all.
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
  Steered,
  Notified,
  TokenUsage,
  CompactionStarted,
  Compacted,
  Retrying,
  RunFinished,
  RunFailed,
]);
export type RunEvent = typeof RunEvent.Type;

/** No run in flight has this id: it ended, or never was. */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", {
  runId: Schema.String,
}) {}

export class RunDenied extends Schema.TaggedError<RunDenied>()("RunDenied", {
  agent: Schema.String,
  reason: Schema.String,
}) {}
