import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { describeInterval, parseInterval } from "./Interval.ts";

const read = (input: string) => {
  const parsed = parseInterval(input);
  if (Result.isFailure(parsed)) {
    throw new Error(`expected "${input}" to read as a cadence: ${parsed.failure.message}`);
  }
  return parsed.success;
};

const refused = (input: string) => {
  const parsed = parseInterval(input);
  assert.isTrue(Result.isFailure(parsed), `expected ${input} to be refused`);
  return Result.isFailure(parsed) ? parsed.failure.message : "";
};

describe("parseInterval", () => {
  it("reads a cadence off the front", () => {
    const parsed = read("5m check the deploy");
    assert.strictEqual(parsed.intervalMillis, 300_000);
    assert.strictEqual(parsed.rest, "check the deploy");
    assert.strictEqual(parsed.cadence, "5 minutes");
  });

  it("reads a cadence off the end", () => {
    const parsed = read("check the deploy every 20 minutes");
    assert.strictEqual(parsed.intervalMillis, 1_200_000);
    assert.strictEqual(parsed.rest, "check the deploy");
  });

  it("takes hours and days, long and short", () => {
    assert.strictEqual(read("2h watch it").intervalMillis, 7_200_000);
    assert.strictEqual(read("watch it every 3 hours").intervalMillis, 10_800_000);
    assert.strictEqual(read("1d watch it").intervalMillis, 86_400_000);
  });

  it("keeps a prompt that merely contains the word every", () => {
    const parsed = read("10m tell me every single thing that changed");
    assert.strictEqual(parsed.rest, "tell me every single thing that changed");
  });

  it("keeps the words of the prompt exactly as typed", () => {
    assert.strictEqual(read("5m  Check   the  Deploy ").rest, "Check   the  Deploy");
  });

  it("takes a cadence with nothing after it", () => {
    const parsed = read("15m");
    assert.strictEqual(parsed.intervalMillis, 900_000);
    assert.strictEqual(parsed.rest, "");
  });

  it("refuses a cadence more often than a minute", () => {
    assert.include(refused("30s do it"), "shortest");
  });

  it("refuses a cadence further apart than a week", () => {
    assert.include(refused("30d do it"), "longest");
  });

  it("refuses nothing, zero, and units that are not time", () => {
    assert.include(refused("0m do it"), "more than nothing");
    assert.include(refused("5x do it"), "not a unit of time");
    assert.include(refused("just do it sometimes"), "no cadence");
  });

  it("settles a cadence it read and refused, so no one else is asked about it", () => {
    // A bound this side enforces is the final word: `30s` is not ambiguous,
    // and sending it to a model can only spend a round trip to say the same.
    for (const input of ["30s do it", "30d do it", "0m do it"]) {
      const parsed = parseInterval(input);
      assert.isTrue(Result.isFailure(parsed) && parsed.failure.settled, input);
    }
    // Words this parser has no opinion about are not settled: a model may yet
    // make sense of them.
    for (const input of ["5x do it", "just do it sometimes"]) {
      const parsed = parseInterval(input);
      assert.isTrue(Result.isFailure(parsed) && !parsed.failure.settled, input);
    }
  });

  it("refuses a huge number rather than overflowing into a schedule", () => {
    assert.include(refused("999999999999999999999m do it"), "too far apart");
  });
});

describe("describeInterval", () => {
  it("names the largest whole unit that divides it", () => {
    assert.strictEqual(describeInterval(60_000), "1 minute");
    assert.strictEqual(describeInterval(600_000), "10 minutes");
    assert.strictEqual(describeInterval(7_200_000), "2 hours");
    assert.strictEqual(describeInterval(86_400_000), "1 day");
  });
});
