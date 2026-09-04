import { Result } from "effect";

/**
 * Reading a cadence out of what someone typed, without a model and without a
 * clock.
 *
 * This covers the forms people actually type — `5m`, `every 20 minutes` — so
 * the common case costs no round trip and fails the same way every time. What
 * it does not cover it refuses rather than guesses, and the caller may then
 * ask a model (see `ScheduleParse`). Refusing is the whole contract: an
 * interval this returns is one the scheduler will honour exactly, so a cadence
 * shown to a person is never a rounded-off version of a different one.
 */

const UNITS = new Map<string, number>(
  Object.entries({
    s: 1_000,
    sec: 1_000,
    secs: 1_000,
    second: 1_000,
    seconds: 1_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
  }),
);

/** A minute is the shortest cadence worth a model turn; a week is the longest a session outlives. */
export const MIN_INTERVAL_MILLIS = 60_000;
export const MAX_INTERVAL_MILLIS = 7 * 86_400_000;

/** What a cadence and the words left over came to. */
export interface ParsedInterval {
  readonly intervalMillis: number;
  /** What the person typed, with the cadence taken out and nothing else changed. */
  readonly rest: string;
  /** The cadence in words, for the confirmation: `10 minutes`. */
  readonly cadence: string;
}

/** Why a cadence was refused, in words a person reads in the terminal. */
export interface IntervalUnreadable {
  readonly _tag: "IntervalUnreadable";
  readonly message: string;
  /**
   * True when a cadence was read and refused on its merits. The answer will
   * not change, so asking a model is a round trip that can only fail: a bound
   * this side enforces is one no wording gets past.
   */
  readonly settled: boolean;
}

const unreadable = (message: string, settled = false): IntervalUnreadable => ({
  _tag: "IntervalUnreadable",
  message,
  settled,
});

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** `600000` to `10 minutes`, largest whole unit that divides it. */
export const describeInterval = (millis: number): string => {
  for (const [unit, size] of [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ] as const) {
    if (millis % size === 0) {
      return plural(millis / size, unit);
    }
  }
  return plural(Math.round(millis / 1_000), "second");
};

const toMillis = (value: string, unit: string): Result.Result<number, IntervalUnreadable> => {
  const size = UNITS.get(unit.toLowerCase());
  if (size === undefined) {
    return Result.fail(unreadable(`${unit} is not a unit of time`));
  }
  const count = Number(value);
  // The patterns only match digits, so a non-finite count means an overflow.
  if (!Number.isFinite(count) || count <= 0) {
    return Result.fail(unreadable("an interval has to be more than nothing", true));
  }
  const millis = count * size;
  if (millis < MIN_INTERVAL_MILLIS) {
    return Result.fail(
      unreadable(
        `${describeInterval(millis)} is too often; ${describeInterval(MIN_INTERVAL_MILLIS)} is the shortest`,
        true,
      ),
    );
  }
  if (millis > MAX_INTERVAL_MILLIS) {
    return Result.fail(
      unreadable(
        `${describeInterval(millis)} is too far apart; ${describeInterval(MAX_INTERVAL_MILLIS)} is the longest`,
        true,
      ),
    );
  }
  return Result.succeed(millis);
};

/** `10m rest of it`, or `10 minutes rest of it`. */
const LEADING = /^(\d+)\s*([A-Za-z]+)(?:\s+|$)/;
/** `the rest of it every 10m`, or `… every 10 minutes`, at the very end. */
const TRAILING = /\s+every\s+(\d+)\s*([A-Za-z]+)\s*$/i;

/**
 * Take a cadence off the front or the end of what was typed. Nothing else in
 * the text is touched, so a prompt keeps the words the person chose — a
 * prompt that merely contains "every" is not a cadence and comes back whole.
 */
export const parseInterval = (input: string): Result.Result<ParsedInterval, IntervalUnreadable> => {
  const text = input.trim();
  const trailing = TRAILING.exec(text);
  if (trailing !== null) {
    const [matched, value, unit] = trailing;
    // SAFETY: both groups are required by the pattern, so a match has them.
    return Result.map(toMillis(value as string, unit as string), (intervalMillis) => ({
      intervalMillis,
      rest: text.slice(0, text.length - matched.length).trim(),
      cadence: describeInterval(intervalMillis),
    }));
  }
  const leading = LEADING.exec(text);
  if (leading !== null) {
    const [matched, value, unit] = leading;
    // SAFETY: both groups are required by the pattern, so a match has them.
    return Result.map(toMillis(value as string, unit as string), (intervalMillis) => ({
      intervalMillis,
      rest: text.slice(matched.length).trim(),
      cadence: describeInterval(intervalMillis),
    }));
  }
  return Result.fail(
    unreadable(
      "no cadence in that; try `5m`, `every 20 minutes`, or say it in words and it will be read",
    ),
  );
};
