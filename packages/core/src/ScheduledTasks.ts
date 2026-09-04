import {
  type MissedPolicy,
  type ScheduleKind,
  ScheduledInboxRow,
  ScheduledTask,
} from "@magentic/protocol";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { describeInterval } from "./Interval.ts";
import { fireId, isLive, nextSlotAfter, planMissed } from "./ScheduleGrid.ts";
import {
  emptyFile,
  type ScheduleFile,
  ScheduledTaskStore,
  type ScheduledTaskStoreError,
} from "./ScheduledTaskStore.ts";

/** A loop outlives a week of neglect no longer than a conversation is worth resuming. */
export const MAX_LIFETIME_MILLIS = 7 * 86_400_000;

export interface CreateSchedule {
  readonly conversationId: string;
  readonly agent: string;
  readonly kind: ScheduleKind;
  readonly prompt: string;
  readonly intervalMillis: number;
  readonly missed: MissedPolicy;
  readonly expiresAt: Option.Option<DateTime.Utc>;
}

/** What a surface shows about a task, worked out here so every surface says the same thing. */
export interface ScheduleStanding {
  readonly taskId: string;
  readonly conversationId: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly nextFireAt: Option.Option<DateTime.Utc>;
  readonly active: boolean;
}

const standingOf = (task: ScheduledTask): ScheduleStanding => ({
  taskId: task.id,
  conversationId: task.conversationId,
  kind: "loop",
  label: `Loop ${describeInterval(task.intervalMillis)}`,
  detail:
    task.phase === "ended"
      ? (task.endedReason ?? "ended")
      : task.runCount === 0
        ? task.prompt
        : `${task.prompt} · ${task.runCount} so far`,
  nextFireAt: task.phase === "ended" ? Option.none() : Option.fromNullishOr(task.nextFireAt),
  active: task.phase !== "ended",
});

/**
 * The schedules of every conversation: what is due, what has fired and is
 * waiting for a turn, and the timers that make it happen.
 *
 * The store is the truth. A timer is one sleeping fiber derived from a stored
 * absolute time, and it can be interrupted at any moment without losing
 * anything: what it was going to do next is readable from disk. Firing writes
 * a row and says so on `fired`; it does not start a run and does not wait for
 * one. Whoever is listening decides whether a run is worth its cost.
 *
 * The timers do not follow the follower. A fire is a row on disk and costs
 * nothing; only the turn costs anything, and that already waits for a surface
 * to be watching. Tying the timers to the follow instead was worse in both
 * directions: a reconnect killed the schedule outright, and an unwatched
 * conversation still owed a turn per slot. At most one fire waits per task,
 * so what a long quiet leaves behind is one turn and a record of what it
 * skipped, however many slots went by.
 */
export class ScheduledTasks extends Context.Service<
  ScheduledTasks,
  {
    create(input: CreateSchedule): Effect.Effect<ScheduledTask, ScheduledTaskStoreError>;
    list(conversationId: string): Effect.Effect<ReadonlyArray<ScheduledTask>>;
    /** False when no live task of the conversation has that id. */
    remove(conversationId: string, id: string): Effect.Effect<boolean, ScheduledTaskStoreError>;
    /** Every live task of the conversation ended at once; how many there were. */
    removeAll(conversationId: string): Effect.Effect<number, ScheduledTaskStoreError>;
    /**
     * The oldest fire waiting on the conversation, taken out of the inbox.
     * Called by the runner inside its per-conversation lock, so a fire becomes
     * a turn between turns and never lands inside one.
     */
    takeQueued(conversationId: string): Effect.Effect<Option.Option<ScheduledInboxRow>>;
    /** What a run of that fire came to, folded into the task's totals. */
    settle(
      conversationId: string,
      taskId: string,
      usage: { readonly inputTokens: number; readonly outputTokens: number },
    ): Effect.Effect<void>;
    /** Arm the conversation's timers, settling whatever its downtime owed. Idempotent. */
    arm(conversationId: string): Effect.Effect<void>;
    /** Where each task of the conversation stands, for a surface to show. */
    standing(conversationId: string): Effect.Effect<ReadonlyArray<ScheduleStanding>>;
    /** A conversation with a fire waiting, for whoever would start a turn on it. */
    readonly fired: Stream.Stream<string>;
    /** Every standing as it changes, for surfaces following a conversation. */
    readonly changed: Stream.Stream<ScheduleStanding>;
  }
>()("magentic/core/ScheduledTasks") {
  static readonly layer = Layer.effect(
    ScheduledTasks,
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore;
      const scope = yield* Scope.Scope;
      const fires = yield* PubSub.unbounded<string>();
      const changes = yield* PubSub.unbounded<ScheduleStanding>();
      /** One writer at a time across every conversation: the files are small and the writes are rare. */
      const writing = yield* Semaphore.make(1);
      const timers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>());

      const announce = (task: ScheduledTask) =>
        Effect.asVoid(PubSub.publish(changes, standingOf(task)));

      /**
       * Read, change, write, under one lock. Every mutation goes through here
       * so a timer firing and a person stopping the loop cannot each write a
       * file built from what they read before the other wrote.
       */
      const modify = <A>(
        conversationId: string,
        f: (file: ScheduleFile) => readonly [A, ScheduleFile],
      ): Effect.Effect<A, ScheduledTaskStoreError> =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            const file = yield* store.read(conversationId);
            const [value, next] = f(file);
            yield* store.write(conversationId, next);
            return value;
          }),
        );

      const readTasks = (conversationId: string) =>
        store.read(conversationId).pipe(
          Effect.map((file) => file.tasks),
          Effect.orElseSucceed((): ReadonlyArray<ScheduledTask> => []),
        );

      /**
       * Record what the slot owes and move the task on, in one write. A fire
       * whose row is already there is not written twice — the row id says the
       * conversation was already told about that slot.
       */
      const fire = Effect.fnUntraced(function* (conversationId: string, taskId: string) {
        const now = yield* DateTime.now;
        const wrote = yield* modify(conversationId, (file) => {
          const task = file.tasks.find((candidate) => candidate.id === taskId);
          if (task === undefined || !isLive(task, now)) {
            return [Option.none<ScheduledTask>(), file] as const;
          }
          const due = Option.fromNullishOr(task.nextFireAt);
          if (Option.isNone(due)) {
            return [Option.none<ScheduledTask>(), file] as const;
          }
          const plan = planMissed(task, due.value, now);
          // One waiting fire per task, however many slots went by. A second
          // says nothing the first does not, and a conversation nobody
          // follows would otherwise collect a row a minute until it expires.
          const waiting = file.inbox.some((existing) => existing.taskId === task.id);
          const rows = waiting
            ? []
            : plan.fireSlots
                .slice(-1)
                .map(
                  (slot) =>
                    new ScheduledInboxRow({
                      id: fireId(task.id, slot),
                      taskId: task.id,
                      slotAt: slot,
                      prompt: task.prompt,
                      admittedAt: now,
                    }),
                )
                .filter((row) => !file.inbox.some((existing) => existing.id === row.id));
          const moved = new ScheduledTask({
            ...task,
            phase: rows.length > 0 ? "queued" : "waiting",
            nextFireAt: plan.nextFireAt,
            lastFiredSlotAt:
              plan.fireSlots.at(-1) ??
              Option.getOrUndefined(Option.fromNullishOr(task.lastFiredSlotAt)),
            lastMissed:
              plan.skipped > 0 || plan.truncated
                ? {
                    policy: task.missed,
                    evaluatedAt: now,
                    dueSlotAt: due.value,
                    fired: plan.fired,
                    skipped: plan.skipped,
                    truncated: plan.truncated,
                  }
                : task.lastMissed,
          });
          return [
            Option.some(moved),
            {
              ...file,
              tasks: file.tasks.map((candidate) => (candidate.id === taskId ? moved : candidate)),
              inbox: [...file.inbox, ...rows],
            },
          ] as const;
        }).pipe(Effect.orElseSucceed(() => Option.none<ScheduledTask>()));
        if (Option.isNone(wrote)) {
          return;
        }
        yield* announce(wrote.value);
        // Said after the row is on disk, so anyone who acts on it finds it there.
        yield* PubSub.publish(fires, conversationId);
      });

      /**
       * One fiber per armed task, sleeping to an absolute time and re-reading
       * the store when it wakes. Sleeping to a stored instant rather than
       * repeating an interval means a fiber that starts late, or is replaced,
       * cannot drift the grid.
       */
      const runTimer = Effect.fnUntraced(function* (conversationId: string, taskId: string) {
        while (true) {
          const tasks = yield* readTasks(conversationId);
          const task = tasks.find((candidate) => candidate.id === taskId);
          const now = yield* DateTime.now;
          if (task === undefined || !isLive(task, now)) {
            return;
          }
          const due = Option.fromNullishOr(task.nextFireAt);
          if (Option.isNone(due)) {
            return;
          }
          const wait = DateTime.toEpochMillis(due.value) - DateTime.toEpochMillis(now);
          if (wait > 0) {
            yield* Effect.sleep(Duration.millis(wait));
          }
          yield* fire(conversationId, taskId);
        }
      });

      const timerKey = (conversationId: string, taskId: string) => `${conversationId} ${taskId}`;

      const startTimer = Effect.fnUntraced(function* (conversationId: string, taskId: string) {
        const key = timerKey(conversationId, taskId);
        if ((yield* Ref.get(timers)).has(key)) {
          return;
        }
        const fiber = yield* Effect.forkIn(runTimer(conversationId, taskId), scope);
        yield* Ref.update(timers, (all) => new Map(all).set(key, fiber));
      });

      const stopTimer = Effect.fnUntraced(function* (conversationId: string, taskId: string) {
        const key = timerKey(conversationId, taskId);
        const found = yield* Ref.modify(
          timers,
          (all): [Option.Option<Fiber.Fiber<void>>, Map<string, Fiber.Fiber<void>>] => {
            const fiber = all.get(key);
            if (fiber === undefined) {
              return [Option.none(), all];
            }
            const next = new Map(all);
            next.delete(key);
            return [Option.some(fiber), next];
          },
        );
        if (Option.isSome(found)) {
          yield* Fiber.interrupt(found.value);
        }
      });

      const end = Effect.fnUntraced(function* (
        conversationId: string,
        taskId: string,
        reason: string,
      ) {
        // Written before the fiber is interrupted: a timer that wakes after
        // the write reads `ended` and stops of its own accord, so there is no
        // window where an ended task can arm itself again.
        const ended = yield* modify(conversationId, (file) => {
          const task = file.tasks.find((candidate) => candidate.id === taskId);
          if (task === undefined || task.phase === "ended") {
            return [Option.none<ScheduledTask>(), file] as const;
          }
          const stopped = new ScheduledTask({
            ...task,
            phase: "ended",
            nextFireAt: undefined,
            endedReason: reason,
          });
          return [
            Option.some(stopped),
            {
              ...file,
              tasks: file.tasks.map((candidate) => (candidate.id === taskId ? stopped : candidate)),
              inbox: file.inbox.filter((row) => row.taskId !== taskId),
            },
          ] as const;
        }).pipe(Effect.orElseSucceed(() => Option.none<ScheduledTask>()));
        yield* stopTimer(conversationId, taskId);
        if (Option.isSome(ended)) {
          yield* announce(ended.value);
        }
        return Option.isSome(ended);
      });

      const create = Effect.fn("ScheduledTasks.create")(function* (input: CreateSchedule) {
        const now = yield* DateTime.now;
        const ceiling = DateTime.makeUnsafe(DateTime.toEpochMillis(now) + MAX_LIFETIME_MILLIS);
        const expiresAt = Option.match(input.expiresAt, {
          onNone: () => ceiling,
          onSome: (asked) =>
            DateTime.toEpochMillis(asked) < DateTime.toEpochMillis(ceiling) ? asked : ceiling,
        });
        const task = new ScheduledTask({
          id: crypto.randomUUID().slice(0, 8),
          conversationId: input.conversationId,
          agent: input.agent,
          kind: input.kind,
          prompt: input.prompt,
          anchorAt: now,
          intervalMillis: input.intervalMillis,
          missed: input.missed,
          phase: "waiting",
          expiresAt,
          nextFireAt: nextSlotAfter(now, input.intervalMillis, now),
          runCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        });
        // Stored before it is armed, so a timer can never outlive the record
        // that says what it is for.
        yield* modify(input.conversationId, (file) => [
          undefined,
          { ...file, tasks: [...file.tasks, task] },
        ]);
        yield* startTimer(input.conversationId, task.id);
        yield* announce(task);
        return task;
      });

      const arm = Effect.fnUntraced(function* (conversationId: string) {
        const now = yield* DateTime.now;
        const tasks = yield* readTasks(conversationId);
        for (const task of tasks) {
          if (!isLive(task, now)) {
            if (task.phase !== "ended") {
              yield* end(conversationId, task.id, "expired");
            }
            continue;
          }
          yield* startTimer(conversationId, task.id);
        }
        // Anything that fired while nobody followed is waiting in the inbox.
        const file = yield* store.read(conversationId).pipe(Effect.orElseSucceed(() => emptyFile));
        if (file.inbox.length > 0) {
          yield* PubSub.publish(fires, conversationId);
        }
      });

      const takeQueued = Effect.fnUntraced(function* (conversationId: string) {
        return yield* modify(conversationId, (file) => {
          const [row, ...rest] = file.inbox;
          if (row === undefined) {
            return [Option.none<ScheduledInboxRow>(), file] as const;
          }
          return [
            Option.some(row),
            {
              ...file,
              inbox: rest,
              tasks: file.tasks.map((task) =>
                task.id === row.taskId && task.phase === "queued"
                  ? new ScheduledTask({ ...task, phase: "running" })
                  : task,
              ),
            },
          ] as const;
        }).pipe(Effect.orElseSucceed(() => Option.none<ScheduledInboxRow>()));
      });

      const settle = Effect.fnUntraced(function* (
        conversationId: string,
        taskId: string,
        usage: { readonly inputTokens: number; readonly outputTokens: number },
      ) {
        const now = yield* DateTime.now;
        const settled = yield* modify(conversationId, (file) => {
          const task = file.tasks.find((candidate) => candidate.id === taskId);
          if (task === undefined || task.phase === "ended") {
            return [Option.none<ScheduledTask>(), file] as const;
          }
          const next = new ScheduledTask({
            ...task,
            // A fire that arrived while this run was going is still in the
            // inbox; the phase says so rather than a flag of its own.
            phase: file.inbox.some((row) => row.taskId === taskId) ? "queued" : "waiting",
            runCount: task.runCount + 1,
            lastRunAt: now,
            totalInputTokens: task.totalInputTokens + usage.inputTokens,
            totalOutputTokens: task.totalOutputTokens + usage.outputTokens,
          });
          return [
            Option.some(next),
            {
              ...file,
              tasks: file.tasks.map((candidate) => (candidate.id === taskId ? next : candidate)),
            },
          ] as const;
        }).pipe(Effect.orElseSucceed(() => Option.none<ScheduledTask>()));
        if (Option.isSome(settled)) {
          yield* announce(settled.value);
          if (settled.value.phase === "queued") {
            yield* PubSub.publish(fires, conversationId);
          }
        }
      });

      return ScheduledTasks.of({
        create,
        list: readTasks,
        remove: (conversationId, id) => end(conversationId, id, "stopped"),
        removeAll: Effect.fnUntraced(function* (conversationId: string) {
          const tasks = yield* readTasks(conversationId);
          let stopped = 0;
          for (const task of tasks) {
            if (task.phase !== "ended" && (yield* end(conversationId, task.id, "stopped"))) {
              stopped += 1;
            }
          }
          return stopped;
        }),
        takeQueued,
        settle,
        arm,
        standing: (conversationId) =>
          Effect.map(readTasks(conversationId), (tasks) => tasks.map(standingOf)),
        fired: Stream.fromPubSub(fires),
        changed: Stream.fromPubSub(changes),
      });
    }),
  );
}
