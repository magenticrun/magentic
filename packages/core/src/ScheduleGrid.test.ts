import { assert, describe, it } from "@effect/vitest";
import { MAX_MISSED_CATCHUP, type MissedPolicy } from "@magentic/protocol";
import { DateTime } from "effect";
import { fireId, nextSlotAfter, planMissed } from "./ScheduleGrid.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const MINUTE = 60_000;

const grid = (missed: MissedPolicy) => ({
  anchorAt: at(0),
  intervalMillis: 10 * MINUTE,
  missed,
});

const slots = (plan: { readonly fireSlots: ReadonlyArray<DateTime.Utc> }) =>
  plan.fireSlots.map(DateTime.toEpochMillis);

describe("nextSlotAfter", () => {
  it("lands on the grid, not on the moment it was asked", () => {
    assert.strictEqual(
      DateTime.toEpochMillis(nextSlotAfter(at(0), 10 * MINUTE, at(23 * MINUTE))),
      30 * MINUTE,
    );
  });

  it("moves past a slot it lands exactly on, so a slot never fires twice", () => {
    assert.strictEqual(
      DateTime.toEpochMillis(nextSlotAfter(at(0), 10 * MINUTE, at(20 * MINUTE))),
      30 * MINUTE,
    );
  });

  it("gives the first slot when asked before the anchor", () => {
    assert.strictEqual(
      DateTime.toEpochMillis(nextSlotAfter(at(100 * MINUTE), 10 * MINUTE, at(0))),
      100 * MINUTE,
    );
  });
});

describe("planMissed", () => {
  it("owes nothing before the slot is due", () => {
    const plan = planMissed(grid("once"), at(10 * MINUTE), at(5 * MINUTE));
    assert.deepStrictEqual(slots(plan), []);
    assert.strictEqual(DateTime.toEpochMillis(plan.nextFireAt), 10 * MINUTE);
  });

  it("fires once when merely a little late, whatever the policy", () => {
    for (const missed of ["skip", "once", "all"] as const) {
      const plan = planMissed(grid(missed), at(10 * MINUTE), at(10 * MINUTE + 900));
      assert.deepStrictEqual(slots(plan), [10 * MINUTE], missed);
      assert.strictEqual(plan.skipped, 0, missed);
      assert.strictEqual(DateTime.toEpochMillis(plan.nextFireAt), 20 * MINUTE, missed);
    }
  });

  it("resumes on the grid rather than an interval from now", () => {
    // Ten slots went by and the clock is mid-slot; the next one is the grid's,
    // not `now + interval`, which would be 113 minutes.
    const plan = planMissed(grid("once"), at(10 * MINUTE), at(103 * MINUTE));
    assert.strictEqual(DateTime.toEpochMillis(plan.nextFireAt), 110 * MINUTE);
  });

  describe("when ten slots went by", () => {
    const due = at(10 * MINUTE);
    const now = at(103 * MINUTE);

    it("skip fires nothing and says how many it dropped", () => {
      const plan = planMissed(grid("skip"), due, now);
      assert.deepStrictEqual(slots(plan), []);
      assert.strictEqual(plan.fired, 0);
      assert.strictEqual(plan.skipped, 10);
    });

    it("once fires the most recent slot, not the oldest", () => {
      const plan = planMissed(grid("once"), due, now);
      assert.deepStrictEqual(slots(plan), [100 * MINUTE]);
      assert.strictEqual(plan.skipped, 9);
    });

    it("all fires every slot, oldest first", () => {
      const plan = planMissed(grid("all"), due, now);
      assert.strictEqual(plan.fired, 10);
      assert.strictEqual(slots(plan).at(0), 10 * MINUTE);
      assert.strictEqual(slots(plan).at(-1), 100 * MINUTE);
      assert.isFalse(plan.truncated);
    });
  });

  it("caps a long absence rather than owing a stampede", () => {
    const interval = MINUTE;
    const plan = planMissed(
      { anchorAt: at(0), intervalMillis: interval, missed: "all" },
      at(interval),
      at(10_000 * interval),
    );
    assert.strictEqual(plan.fired, MAX_MISSED_CATCHUP);
    assert.isTrue(plan.truncated);
    assert.strictEqual(plan.fired + plan.skipped, 10_000);
  });
});

describe("fireId", () => {
  it("is the same for the same slot, so one fire is admitted once", () => {
    assert.strictEqual(fireId("abc", at(60_000)), fireId("abc", at(60_000)));
  });

  it("differs by slot and by task", () => {
    assert.notStrictEqual(fireId("abc", at(60_000)), fireId("abc", at(120_000)));
    assert.notStrictEqual(fireId("abc", at(60_000)), fireId("xyz", at(60_000)));
  });
});
