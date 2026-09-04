import { MAX_MISSED_CATCHUP, type MissedPolicy, type ScheduledTask } from "@magentic/protocol";
import { DateTime } from "effect";

/**
 * When a repeating task is due, and what it owes for the slots that went by
 * while nothing ran.
 *
 * Everything here is arithmetic on a grid: slots land on
 * `anchor + n * interval`, so a cadence stays a cadence no matter how long a
 * turn took or how long the process was down. Advancing by `now + interval`
 * after each run instead would let a slow turn walk the schedule forward for
 * the rest of its life.
 *
 * Kept apart from the service so the rules can be read and tested without a
 * clock, a store, or a conversation.
 */

/** The first slot strictly after `after`. */
export const nextSlotAfter = (
  anchor: DateTime.Utc,
  intervalMillis: number,
  after: DateTime.Utc,
): DateTime.Utc => {
  const origin = DateTime.toEpochMillis(anchor);
  const at = DateTime.toEpochMillis(after);
  const elapsed = at - origin;
  const passed = elapsed < 0 ? -1 : Math.floor(elapsed / intervalMillis);
  return DateTime.makeUnsafe(origin + (passed + 1) * intervalMillis);
};

/** Which slots to speak to now, and where the grid picks up. */
export interface MissedPlan {
  /** Oldest first. Empty means nothing is owed; the task just waits. */
  readonly fireSlots: ReadonlyArray<DateTime.Utc>;
  readonly nextFireAt: DateTime.Utc;
  readonly fired: number;
  readonly skipped: number;
  /** Whether the backlog hit the cap, so `skipped` is a ceiling rather than a decision. */
  readonly truncated: boolean;
}

/**
 * What `now` owes a task waiting on `dueSlot`.
 *
 * Being a little late is the ordinary case — the timer wakes a moment after
 * the slot — and always fires exactly once. The policy is only consulted when
 * more than one slot has gone by, which means the process was down or nobody
 * was following.
 */
export const planMissed = (
  options: {
    readonly anchorAt: DateTime.Utc;
    readonly intervalMillis: number;
    readonly missed: MissedPolicy;
  },
  dueSlot: DateTime.Utc,
  now: DateTime.Utc,
): MissedPlan => {
  const due = DateTime.toEpochMillis(dueSlot);
  const at = DateTime.toEpochMillis(now);
  const resume = nextSlotAfter(options.anchorAt, options.intervalMillis, now);
  if (at < due) {
    return { fireSlots: [], nextFireAt: dueSlot, fired: 0, skipped: 0, truncated: false };
  }
  const owed = Math.floor((at - due) / options.intervalMillis) + 1;
  const slotAt = (index: number) => DateTime.makeUnsafe(due + index * options.intervalMillis);
  if (owed <= 1) {
    return { fireSlots: [dueSlot], nextFireAt: resume, fired: 1, skipped: 0, truncated: false };
  }
  switch (options.missed) {
    case "skip":
      // The value of these expired with their slots; a stale answer is worse
      // than none.
      return { fireSlots: [], nextFireAt: resume, fired: 0, skipped: owed, truncated: false };
    case "once": {
      // What a person expects after closing a laptop: catch up, once, on the
      // most recent slot rather than the oldest.
      const latest = slotAt(owed - 1);
      return {
        fireSlots: [latest],
        nextFireAt: resume,
        fired: 1,
        skipped: owed - 1,
        truncated: false,
      };
    }
    case "all": {
      const firing = Math.min(owed, MAX_MISSED_CATCHUP);
      return {
        fireSlots: Array.from({ length: firing }, (_, index) => slotAt(owed - firing + index)),
        nextFireAt: resume,
        fired: firing,
        skipped: owed - firing,
        truncated: owed > MAX_MISSED_CATCHUP,
      };
    }
  }
};

/** Whether the task can still fire at all, whatever its phase says. */
export const isLive = (task: ScheduledTask, now: DateTime.Utc): boolean =>
  task.phase !== "ended" && DateTime.toEpochMillis(now) < DateTime.toEpochMillis(task.expiresAt);

/**
 * The id of one fire, from the task and the slot it belongs to.
 *
 * Derived rather than random on purpose: writing the same fire twice is then
 * the same row, so a process that dies between recording a fire and speaking
 * to it leaves exactly one row for the next resume, and one that dies after
 * speaking cannot wake the conversation for that slot a second time.
 */
export const fireId = (taskId: string, slot: DateTime.Utc): string =>
  `${taskId}:${DateTime.toEpochMillis(slot)}`;
