import { assert, layer } from "@effect/vitest";
import { DateTime, Deferred, Effect, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ScheduledTaskStore } from "./ScheduledTaskStore.ts";
import { ScheduledTasks } from "./ScheduledTasks.ts";

const MINUTE = 60_000;

const TestLayer = ScheduledTasks.layer.pipe(Layer.provideMerge(ScheduledTaskStore.layerMemory));

const armed = (conversationId: string, intervalMillis = 10 * MINUTE) =>
  Effect.flatMap(ScheduledTasks, (schedules) =>
    schedules.create({
      conversationId,
      agent: "talker",
      kind: "prompt",
      prompt: "tick",
      intervalMillis,
      missed: "once",
      expiresAt: Option.none(),
    }),
  );

layer(TestLayer)("ScheduledTasks", (it) => {
  it.effect("arms a task on the grid rather than an interval from now", () =>
    Effect.gen(function* () {
      const task = yield* armed("c1");
      assert.strictEqual(task.phase, "waiting");
      const next = Option.fromNullishOr(task.nextFireAt);
      assert.isTrue(Option.isSome(next));
      assert.strictEqual(
        DateTime.toEpochMillis(Option.getOrThrow(next)) - DateTime.toEpochMillis(task.anchorAt),
        10 * MINUTE,
      );
    }),
  );

  it.effect("puts exactly one fire in the inbox when a slot comes due", () =>
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore;
      const schedules = yield* ScheduledTasks;
      // Told before the clock moves, so the fire cannot be missed between the
      // advance and the read.
      const told = yield* Deferred.make<string>();
      // Every test in this block shares one service, so another test's task
      // may fire first; this waits for the one it armed.
      yield* Effect.forkChild(
        Stream.runForEach(schedules.fired, (id) =>
          id === "c2" ? Deferred.succeed(told, id) : Effect.void,
        ),
      );
      yield* armed("c2");
      yield* TestClock.adjust(`${10 * MINUTE} millis`);
      assert.strictEqual(yield* Deferred.await(told), "c2");
      const file = yield* store.read("c2");
      assert.strictEqual(file.inbox.length, 1);
      assert.strictEqual(file.inbox.at(0)?.prompt, "tick");
      assert.strictEqual(file.tasks.at(0)?.phase, "queued");
    }),
  );

  it.effect("advances to the next slot on the grid after it fires", () =>
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore;
      const task = yield* armed("c3");
      yield* TestClock.adjust(`${10 * MINUTE} millis`);
      const after = (yield* store.read("c3")).tasks.at(0);
      const next = Option.fromNullishOr(after?.nextFireAt);
      assert.isTrue(Option.isSome(next));
      assert.strictEqual(
        DateTime.toEpochMillis(Option.getOrThrow(next)) - DateTime.toEpochMillis(task.anchorAt),
        20 * MINUTE,
      );
    }),
  );

  it.effect("a stopped task never fires again", () =>
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore;
      const schedules = yield* ScheduledTasks;
      const task = yield* armed("c4");
      assert.isTrue(yield* schedules.remove("c4", task.id));
      yield* TestClock.adjust(`${60 * MINUTE} millis`);
      const file = yield* store.read("c4");
      assert.strictEqual(file.inbox.length, 0);
      assert.strictEqual(file.tasks.at(0)?.phase, "ended");
    }),
  );

  it.effect("takes one fire at a time out of the inbox", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduledTasks;
      const store = yield* ScheduledTaskStore;
      yield* armed("c5");
      yield* TestClock.adjust(`${10 * MINUTE} millis`);
      const taken = yield* schedules.takeQueued("c5");
      assert.isTrue(Option.isSome(taken));
      assert.strictEqual((yield* store.read("c5")).inbox.length, 0);
      assert.isTrue(Option.isNone(yield* schedules.takeQueued("c5")));
    }),
  );
});
