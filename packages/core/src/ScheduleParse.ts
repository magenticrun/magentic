import { DateTime, Effect, Option, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { MAX_INTERVAL_MILLIS, MIN_INTERVAL_MILLIS } from "./Interval.ts";

/**
 * Reading a cadence a person said in words, when `parseInterval` would not
 * have it: `twice an hour`, `until 3pm`, `every other minute`.
 *
 * The model reads the intent and this works out the numbers. That split is the
 * whole point. A model is reliable at "they mean every ten minutes, stopping
 * at three"; it is not reliable at "that is 11,520 seconds from now", and a
 * wrong number there is silent. So the schema asks for a duration in seconds
 * where the person spoke in durations, and for a clock reading where they
 * spoke in clock readings, and never for a subtraction.
 *
 * `now` is given to this call and to no other. The agent's own system prompt
 * is the cache prefix of every turn; a clock in it would either be stale or
 * would spoil the cache on every request.
 */

/** How often to repeat. A one-off is still a schedule: it fires once and ends. */
const Cadence = Schema.Struct({
  kind: Schema.Literals(["every", "once"]),
  /** Seconds between runs. Required for `every`, ignored for `once`. */
  seconds: Schema.optional(Schema.Finite),
});

/**
 * When to stop, if they said. A delay is relative to now and needs no
 * arithmetic; a clock reading is transcription, `3 pm` to `15:00`, and this
 * side resolves it against the real clock and zone.
 */
const Until = Schema.Struct({
  kind: Schema.Literals(["delay", "wallClock"]),
  seconds: Schema.optional(Schema.Finite),
  /** 24-hour `HH:MM` in the person's own zone. */
  time: Schema.optional(Schema.String),
  /** `YYYY-MM-DD`, when they named a day; today or tomorrow is worked out here otherwise. */
  date: Schema.optional(Schema.String),
});

const Read = Schema.Struct({
  cadence: Cadence,
  until: Schema.optional(Until),
  /** What is left to do each time, with the timing words taken out. */
  prompt: Schema.String,
  /** What the model took them to mean, in words, for the person to check. */
  interpretation: Schema.String,
});

/** A cadence read out of words, resolved against a real clock. */
export interface ReadSchedule {
  readonly intervalMillis: number;
  readonly once: boolean;
  readonly until: Option.Option<DateTime.Utc>;
  readonly prompt: string;
  /** What the model took the words to mean; shown beside the times worked out here. */
  readonly interpretation: string;
}

export class ScheduleUnreadable extends Schema.TaggedError<ScheduleUnreadable>()(
  "ScheduleUnreadable",
  { message: Schema.String },
) {}

const INSTRUCTIONS = `You turn a person's words about timing into a schedule.

Rules:
- Give the cadence as seconds between runs. "twice an hour" is 1800 seconds.
- A deadline they gave in relative words ("for the next two hours") is an until of kind "delay" in seconds.
- A deadline they gave as a clock time ("until 3pm", "till midnight") is an until of kind "wallClock" with time as 24-hour HH:MM. Only set date when they named a day.
- Never compute how many seconds away a clock time is. Give the clock reading and nothing more.
- prompt is what they want done each time, with the timing words removed and nothing else changed.
- interpretation is one short phrase saying what you took them to mean.
- If they gave no cadence at all, use a cadence of kind "once".`;

/** `15:00` today in `zone`, or tomorrow when today's has gone by. */
const resolveWallClock = (
  time: string,
  date: Option.Option<string>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): Option.Option<DateTime.Utc> => {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (parts === null) {
    return Option.none();
  }
  const [, rawHours, rawMinutes] = parts;
  if (rawHours === undefined || rawMinutes === undefined) {
    return Option.none();
  }
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  if (hours > 23 || minutes > 59) {
    return Option.none();
  }
  const local = DateTime.setZone(now, zone);
  const onDay = Option.match(date, {
    onNone: () => local,
    onSome: (day) => {
      const asked = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
      if (asked === null) {
        return local;
      }
      const [, year, month, dayOfMonth] = asked;
      if (year === undefined || month === undefined || dayOfMonth === undefined) {
        return local;
      }
      return DateTime.setParts(local, {
        year: Number(year),
        month: Number(month),
        day: Number(dayOfMonth),
      });
    },
  });
  const at = DateTime.setParts(onDay, { hour: hours, minute: minutes, second: 0, millisecond: 0 });
  const utc = DateTime.toUtc(at);
  if (Option.isSome(date) || DateTime.toEpochMillis(utc) > DateTime.toEpochMillis(now)) {
    return Option.some(utc);
  }
  // A clock time already gone today means the next one, tomorrow.
  return Option.some(DateTime.toUtc(DateTime.add(at, { days: 1 })));
};

/**
 * Ask the model what the words meant, then work out the times here.
 *
 * Fails rather than guesses: a cadence that comes back outside what the
 * scheduler will honour is refused with the reason, so nothing is armed on a
 * misreading.
 */
export const readSchedule = Effect.fn("ScheduleParse.readSchedule")(function* (
  input: string,
  zone: DateTime.TimeZone,
) {
  const now = yield* DateTime.now;
  const local = DateTime.formatIsoZoned(DateTime.setZone(now, zone));
  const response = yield* LanguageModel.generateObject({
    schema: Read,
    objectName: "schedule",
    prompt: [
      { role: "system", content: INSTRUCTIONS },
      {
        role: "user",
        content: `It is now ${local}.\n\nThe person said: ${input}`,
      },
    ],
  }).pipe(
    // Not the same thing as words that make no sense: the reading never
    // happened. Saying which is the difference between a person rewording a
    // cadence that was fine and a person waiting for the model to come back.
    Effect.mapError(
      (error) =>
        new ScheduleUnreadable({
          message: `the timing was not read: the model did not answer (${error.message}). A plain cadence like \`10m\` or \`every 20 minutes\` needs no model.`,
        }),
    ),
  );
  const read = response.value;
  const prompt = read.prompt.trim();
  if (prompt.length === 0) {
    return yield* new ScheduleUnreadable({ message: "there is nothing to do on that schedule" });
  }
  const seconds = read.cadence.kind === "once" ? 0 : (read.cadence.seconds ?? 0);
  const intervalMillis = read.cadence.kind === "once" ? MIN_INTERVAL_MILLIS : seconds * 1_000;
  if (read.cadence.kind === "every") {
    if (intervalMillis < MIN_INTERVAL_MILLIS) {
      return yield* new ScheduleUnreadable({
        message: `${read.interpretation} is more often than once a minute, which is as often as a loop goes`,
      });
    }
    if (intervalMillis > MAX_INTERVAL_MILLIS) {
      return yield* new ScheduleUnreadable({
        message: `${read.interpretation} is further apart than a week, which is as long as a loop lives`,
      });
    }
  }
  const until = Option.flatMap(Option.fromNullishOr(read.until), (asked) =>
    asked.kind === "delay"
      ? Option.map(Option.fromNullishOr(asked.seconds), (delay) =>
          DateTime.makeUnsafe(DateTime.toEpochMillis(now) + delay * 1_000),
        )
      : Option.flatMap(Option.fromNullishOr(asked.time), (time) =>
          resolveWallClock(time, Option.fromNullishOr(asked.date), now, zone),
        ),
  );
  const result: ReadSchedule = {
    intervalMillis,
    once: read.cadence.kind === "once",
    until,
    prompt,
    interpretation: read.interpretation,
  };
  return result;
});
