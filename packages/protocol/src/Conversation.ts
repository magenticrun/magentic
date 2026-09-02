import { Schema } from "effect";
import { TokenUsage } from "./Run.ts";

/** Tokens a conversation has used: the latest model call, whose input is the context in use, and running totals. */
export const ConversationUsage = Schema.Struct({
  latest: TokenUsage,
  /** Model calls so far; a run with tool calls makes several. */
  calls: Schema.Number,
  totalInputTokens: Schema.Number,
  totalOutputTokens: Schema.Number,
});
export type ConversationUsage = typeof ConversationUsage.Type;

/**
 * A chain of runs that share history, as the gateway keeps it between
 * sessions. Runs update it; surfaces list and resume it.
 */
export class Conversation extends Schema.Class<Conversation>("magentic/protocol/Conversation")({
  id: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  /** Whose it is; nobody else lists or resumes it. */
  principal: Schema.String,
  /** The first input, clipped to a line. */
  title: Schema.String,
  /** The `provider/model` the latest run used, when one resolved. */
  model: Schema.optional(Schema.String),
  /** Where the surface was working when it started; absent for runs that did not say. */
  directory: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  /** Messages in the history, the system prompt included. */
  messages: Schema.Number,
  /** Absent until a model call has reported. */
  usage: Schema.optional(ConversationUsage),
}) {}

/** What was said, for a surface to draw a resumed conversation. Reasoning is left out. */
export const TranscriptUser = Schema.TaggedStruct("User", { text: Schema.String });
export const TranscriptAssistant = Schema.TaggedStruct("Assistant", { text: Schema.String });
export const TranscriptTool = Schema.TaggedStruct("Tool", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
  /** Absent when the run ended before the tool answered. */
  result: Schema.optional(Schema.Json),
  isFailure: Schema.Boolean,
});
/** Where a compaction happened: the summary the model continued from. */
export const TranscriptSummary = Schema.TaggedStruct("Summary", { text: Schema.String });
export const TranscriptEntry = Schema.Union([
  TranscriptUser,
  TranscriptAssistant,
  TranscriptTool,
  TranscriptSummary,
]);
export type TranscriptEntry = typeof TranscriptEntry.Type;

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { id: Schema.String },
) {}

/** The conversation could not be compacted: nothing to fold yet, or the model gave no summary. */
export class CompactionFailed extends Schema.TaggedError<CompactionFailed>()("CompactionFailed", {
  id: Schema.String,
  message: Schema.String,
}) {}
