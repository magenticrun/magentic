import { Schema } from "effect";
import { ConversationId } from "./ConversationId.ts";

/**
 * What a schedule repeats. Only `prompt` runs today: the tick becomes a turn
 * the model answers. `command` is the cheaper shape a later version wants —
 * run something, wake the model only when the result is worth reporting — and
 * the field is here so that arriving is a new branch rather than a migration
 * of every stored record.
 */
export const ScheduleKind = Schema.Literals(["prompt", "command"]);
export type ScheduleKind = typeof ScheduleKind.Type;

/**
 * What a schedule owes for the slots that passed while nothing ran, whether
 * because the gateway was down or because nobody was following. Consulted only
 * when a task is behind by more than one slot; being a little late is the
 * ordinary case and always fires exactly once.
 */
export const MissedPolicy = Schema.Literals(["skip", "once", "all"]);
export type MissedPolicy = typeof MissedPolicy.Type;

/** How many slots one `all` catch-up may fire, so a week of downtime is not a stampede. */
export const MAX_MISSED_CATCHUP = 100;

/**
 * Where a task stands. `waiting` is armed with a future slot; `queued` has a
 * row in the inbox that no run has taken yet; `running` is being spoken to;
 * `suspended` kept its record but has no timer, because nobody follows the
 * conversation; `ended` was stopped or expired and can never arm again.
 */
export const SchedulePhase = Schema.Literals([
  "waiting",
  "queued",
  "running",
  "suspended",
  "ended",
]);
export type SchedulePhase = typeof SchedulePhase.Type;

/** What the last missed-slot decision did, so a gap is read rather than inferred. */
export const MissedOutcome = Schema.Struct({
  policy: MissedPolicy,
  evaluatedAt: Schema.DateTimeUtcFromString,
  /** The slot the task was waiting on when the decision ran. */
  dueSlotAt: Schema.DateTimeUtcFromString,
  fired: Schema.Finite,
  skipped: Schema.Finite,
  /** Whether the backlog hit `MAX_MISSED_CATCHUP`, so `skipped` is a cap, not a policy. */
  truncated: Schema.Boolean,
});
export type MissedOutcome = typeof MissedOutcome.Type;

/**
 * A repeating turn on one conversation, as the surfaces see it.
 *
 * Slots land on `anchorAt + n * intervalMillis`, never on "whenever the last
 * run finished", so a cadence stays a cadence across a slow turn. `lastRunAt`
 * is when a run happened; `lastFiredSlotAt` is the slot it answered, which is
 * earlier whenever a catch-up ran.
 */
export class ScheduledTask extends Schema.Class<ScheduledTask>("magentic/protocol/ScheduledTask")({
  id: Schema.NonEmptyString,
  conversationId: ConversationId,
  agent: Schema.NonEmptyString,
  kind: ScheduleKind,
  prompt: Schema.String,
  /** The origin of the slot grid. */
  anchorAt: Schema.DateTimeUtcFromString,
  intervalMillis: Schema.Finite,
  missed: MissedPolicy,
  phase: SchedulePhase,
  /** When the task stops on its own, whether the person asked for a deadline or not. */
  expiresAt: Schema.DateTimeUtcFromString,
  nextFireAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastFiredSlotAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastRunAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastMissed: Schema.optional(MissedOutcome),
  runCount: Schema.Finite,
  totalInputTokens: Schema.Finite,
  totalOutputTokens: Schema.Finite,
  /** Why it ended, once it has; absent while it can still fire. */
  endedReason: Schema.optional(Schema.String),
}) {}

/**
 * One fire, waiting for a turn to take it.
 *
 * The id is derived from the task and the slot, so writing the same fire twice
 * is the same row: a process that dies between writing and speaking leaves the
 * row for the next resume, and one that dies after speaking cannot wake the
 * conversation for that slot again. This is why a fire needs no record of its
 * own beside the inbox. The prompt is stored rather than recomputed — a prompt
 * that has to be rebuilt at delivery time is one that can be rebuilt
 * differently.
 */
export class ScheduledInboxRow extends Schema.Class<ScheduledInboxRow>(
  "magentic/protocol/ScheduledInboxRow",
)({
  id: Schema.NonEmptyString,
  taskId: Schema.NonEmptyString,
  /** The grid slot this fire belongs to, with `taskId` the whole identity of a fire. */
  slotAt: Schema.DateTimeUtcFromString,
  prompt: Schema.String,
  admittedAt: Schema.DateTimeUtcFromString,
}) {}

/**
 * A cadence read out of a person's own words.
 *
 * `interpretation` is what the reader took them to mean, in words. A surface
 * shows it beside the times it worked out, so a misreading is visible before
 * anything is armed rather than an hour later.
 */
export class ReadScheduleResult extends Schema.Class<ReadScheduleResult>(
  "magentic/protocol/ReadScheduleResult",
)({
  intervalMillis: Schema.Finite,
  prompt: Schema.String,
  until: Schema.optional(Schema.DateTimeUtcFromString),
  interpretation: Schema.String,
}) {}

/** No schedule by that id on that conversation, or it is not the caller's. */
export class ScheduleNotFound extends Schema.TaggedError<ScheduleNotFound>()("ScheduleNotFound", {
  id: Schema.String,
}) {}

/** The schedule could not be read, or would never fire. */
export class ScheduleInvalid extends Schema.TaggedError<ScheduleInvalid>()("ScheduleInvalid", {
  message: Schema.String,
}) {}
