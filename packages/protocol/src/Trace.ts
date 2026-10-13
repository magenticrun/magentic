import { Schema } from "effect";

/**
 * One finished span of a run, as the gateway keeps it beside the
 * conversation: what ran, when, under what, and how it ended. Times are
 * microseconds since the epoch, the unit Chrome's trace format counts in;
 * OTLP's nanoseconds are these times a thousand. Attributes are the span's
 * own, `gen_ai.*` and `magentic.*` among them, as JSON.
 */
export class TraceSpan extends Schema.Class<TraceSpan>("TraceSpan")({
  traceId: Schema.String,
  spanId: Schema.String,
  /** Absent for a run's own span, which starts a trace of its own. */
  parentSpanId: Schema.optional(Schema.String),
  name: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
  status: Schema.Literals(["ok", "error", "interrupted"]),
  /** What went wrong, for a span that ended in error. */
  error: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Json),
}) {}

/**
 * The attribute a run's span carries its conversation in, as OpenTelemetry's
 * GenAI conventions name it; every span under it belongs there too.
 */
export const TRACE_CONVERSATION = "gen_ai.conversation.id";
/** The attribute a run's span carries its run in. */
export const TRACE_RUN = "magentic.run.id";
/** What a span of magentic's own stands for: `run`, `model` (one call, retries included), or `tool`. */
export const TRACE_KIND = "magentic.kind";
