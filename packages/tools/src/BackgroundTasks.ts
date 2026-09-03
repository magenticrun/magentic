import { Notices } from "@magentic/plugin";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type Bounded, EMPTY, push, render, tailOf, ToolOutputDir } from "./ToolOutput.ts";

/** Tasks that may exist at once, running or ended; past it the oldest ended one goes first. */
export const MAX_TASKS = 32;
/** Characters of a task's last output a notice carries; `task_output` has the rest. */
export const NOTICE_TAIL = 2_000;
/** How long a stopped or timed-out command gets to exit on SIGTERM before SIGKILL. */
const FORCE_KILL_AFTER = "2 seconds";
/** How long the readers may keep draining after the command ended before we take what they have. */
const COLLECT_GRACE = "2 seconds";

export class TaskStartError extends Schema.TaggedError<TaskStartError>()("TaskStartError", {
  reason: Schema.Literals(["TaskLimit", "SpawnFailed"]),
  message: Schema.String,
}) {}

/** Whose task it is: only their calls see it, and its notices go to their conversation. */
export interface TaskOwner {
  readonly principal: string;
  readonly conversationId: string;
}

export interface TaskStartOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Milliseconds before the command is killed; none for as long as it takes. */
  readonly timeout: Option.Option<number>;
  readonly owner: TaskOwner;
}

/** A background task as the tools report it. */
export interface TaskStatus {
  readonly taskId: string;
  readonly command: string;
  readonly running: boolean;
  /** Null while running, and when it did not exit on its own: stopped, timed out, or killed by a signal. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Whether `task_stop` ended it. */
  readonly stopped: boolean;
  /** How long it ran, or has been running. */
  readonly durationMs: number;
  /** Where the whole of each stream is, from the start, for grep, sed -n, or tail. */
  readonly stdoutFile: string;
  readonly stderrFile: string;
}

/** The status with what the task printed since the last read. */
export interface TaskRead extends TaskStatus {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface Ended {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly at: number;
}

/**
 * Whether the task has ended, and how many calls are waiting for it to. One
 * value, so the end and the count are read together: a call that starts
 * waiting after the end is recorded does not wait, and a call counted
 * before it gets the end as its result, so no notice goes out for it.
 */
interface TaskState {
  readonly waiting: number;
  readonly ended: Option.Option<Ended>;
}

interface Task {
  readonly id: string;
  readonly command: string;
  readonly owner: TaskOwner;
  readonly startedAt: number;
  readonly stdoutFile: string;
  readonly stderrFile: string;
  /** What has streamed in since the last `output` call, bounded like a foreground command's. */
  readonly unread: { readonly stdout: Ref.Ref<Bounded>; readonly stderr: Ref.Ref<Bounded> };
  /** The process, once spawned; how `stop` reaches it. */
  readonly handle: Deferred.Deferred<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError
  >;
  readonly state: Ref.Ref<TaskState>;
  /** Settled once `state` records the end, for whoever waits. */
  readonly done: Deferred.Deferred<void>;
  /** Set before a stop, so the end is not announced as news. */
  readonly stopped: Ref.Ref<boolean>;
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

const describeEnd = (status: TaskStatus, timeout: Option.Option<number>): string => {
  if (status.stopped) {
    return "was stopped";
  }
  if (status.timedOut) {
    return `was killed after its timeout of ${seconds(Option.getOrElse(timeout, () => 0))}`;
  }
  return status.exitCode === null
    ? "was killed by a signal"
    : `exited with code ${status.exitCode}`;
};

/**
 * Commands that run on after the tool call that started them: dev servers,
 * long test runs, builds. Each is the caller's alone. Output streams into a
 * bounded buffer the next `output` call takes, and into two files that hold
 * all of it. When a task ends with nobody waiting on it, the conversation
 * that started it gets a notice, so the model hears before its next call.
 * Every task is killed when the scope the service was made in closes.
 */
export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  {
    /** Spawn the command and return once it is running, or could not be. */
    start(options: TaskStartOptions): Effect.Effect<TaskStatus, TaskStartError>;
    /**
     * The task's status and what it printed since the last read; none when
     * it is not the principal's. Waits up to `wait` for it to end first.
     */
    output(
      taskId: string,
      principal: string,
      wait: Option.Option<number>,
    ): Effect.Effect<Option.Option<TaskRead>>;
    /** Kill the task and wait for it to be gone; none when it is not the principal's. */
    stop(taskId: string, principal: string): Effect.Effect<Option.Option<TaskStatus>>;
    /** The principal's tasks, oldest first; those of one conversation when asked. */
    list(
      principal: string,
      conversationId: Option.Option<string>,
    ): Effect.Effect<ReadonlyArray<TaskStatus>>;
  }
>()("magentic/tools/BackgroundTasks") {
  /** The service, its tasks forked into the surrounding scope so they outlive the calls that start them. */
  static readonly make: Effect.Effect<
    BackgroundTasks["Service"],
    never,
    | Scope.Scope
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | Notices
    | ToolOutputDir
  > = Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const notices = yield* Notices;
    const outputDir = yield* ToolOutputDir;
    const tasks = yield* Ref.make(new Map<string, Task>());
    // Starts take turns, so the cap holds when two are called at once.
    const starting = yield* Semaphore.make(1);

    const statusOf = Effect.fnUntraced(function* (task: Task) {
      const { ended } = yield* Ref.get(task.state);
      const now = yield* Clock.currentTimeMillis;
      const status: TaskStatus = {
        taskId: task.id,
        command: task.command,
        running: Option.isNone(ended),
        exitCode: Option.match(ended, { onNone: () => null, onSome: (e) => e.exitCode }),
        timedOut: Option.match(ended, { onNone: () => false, onSome: (e) => e.timedOut }),
        stopped: yield* Ref.get(task.stopped),
        durationMs:
          Option.match(ended, { onNone: () => now, onSome: (e) => e.at }) - task.startedAt,
        stdoutFile: task.stdoutFile,
        stderrFile: task.stderrFile,
      };
      return status;
    });

    /** The principal's task by id; none for another's, which is as good as no task. */
    const find = (taskId: string, principal: string) =>
      Effect.map(Ref.get(tasks), (all) => {
        const task = all.get(taskId);
        return task !== undefined && task.owner.principal === principal
          ? Option.some(task)
          : Option.none();
      });

    /** Make room for one more: drop the oldest ended task, or fail when every one is running. */
    const makeRoom = Effect.gen(function* () {
      const all = yield* Ref.get(tasks);
      if (all.size < MAX_TASKS) {
        return;
      }
      const ended = yield* Effect.filter([...all.values()], (task) => Deferred.isDone(task.done));
      const oldest = ended.toSorted((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest === undefined) {
        return yield* new TaskStartError({
          reason: "TaskLimit",
          message: `${MAX_TASKS} background tasks are running; stop one before starting another`,
        });
      }
      yield* Ref.update(tasks, (current) => {
        const next = new Map(current);
        next.delete(oldest.id);
        return next;
      });
    });

    const freshId = Effect.gen(function* () {
      const all = yield* Ref.get(tasks);
      let id = crypto.randomUUID().slice(0, 8);
      while (all.has(id)) {
        id = crypto.randomUUID().slice(0, 8);
      }
      return id;
    });

    /** A chunk of a stream into the unread buffer and onto the end of its file. */
    const collect = (
      stream: Stream.Stream<Uint8Array, { readonly message: string }>,
      buffer: Ref.Ref<Bounded>,
      file: string,
    ) =>
      Effect.forkChild(
        stream.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.andThen(
              Ref.update(buffer, (b) => push(b, chunk)),
              fs
                .writeFileString(file, chunk, { flag: "a", mode: 0o600 })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logDebug(`background task: output not appended to ${file}`, cause),
                  ),
                ),
            ),
          ),
          Effect.ignore,
        ),
      );

    /** Wait for a reader to finish; past the grace period take what it has and stop it. */
    const settle = (reader: Fiber.Fiber<void>) =>
      Effect.gen(function* () {
        const done = yield* Fiber.join(reader).pipe(Effect.timeoutOption(COLLECT_GRACE));
        if (Option.isNone(done)) {
          yield* Fiber.interrupt(reader);
        }
      });

    const noticeFor = Effect.fnUntraced(function* (task: Task, timeout: Option.Option<number>) {
      const status = yield* statusOf(task);
      const out = tailOf(yield* Ref.get(task.unread.stdout), NOTICE_TAIL);
      const err = tailOf(yield* Ref.get(task.unread.stderr), NOTICE_TAIL);
      const last = [out, err]
        .map((text) => text.trimEnd())
        .filter((text) => text.trim().length > 0)
        .join("\n");
      return [
        `Background task ${task.id} ended: \`${task.command}\` ${describeEnd(status, timeout)} after ${seconds(status.durationMs)}.`,
        ...(last.length > 0 ? [`Last output:\n\`\`\`\n${last}\n\`\`\``] : []),
        `task_output ${task.id} has everything it printed since you last read it, and names the files that hold the whole of it.`,
      ].join("\n");
    });

    /** The task's life: spawn, drain, wait, and tell the conversation, unless someone was waiting. */
    const run = (task: Task, options: TaskStartOptions) =>
      Effect.gen(function* () {
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make(task.command, {
              shell: true,
              cwd: options.cwd,
              env: options.env,
              extendEnv: true,
              stdin: "ignore",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )
          .pipe(Effect.result);
        if (spawned._tag === "Failure") {
          yield* Deferred.fail(task.handle, spawned.failure);
          return;
        }
        const handle = spawned.success;
        yield* Deferred.succeed(task.handle, handle);
        const stdout = yield* collect(handle.stdout, task.unread.stdout, task.stdoutFile);
        const stderr = yield* collect(handle.stderr, task.unread.stderr, task.stderrFile);
        // A child a signal killed has no exit code, which the spawner reports as a failure.
        const awaited = handle.exitCode.pipe(
          Effect.tapError((error) =>
            Effect.logDebug(`background task ${task.id}: no exit code: ${error.message}`),
          ),
          Effect.result,
        );
        const exit = yield* Option.match(options.timeout, {
          onNone: () => Effect.asSome(awaited),
          onSome: (ms) => Effect.timeoutOption(awaited, ms),
        });
        if (Option.isNone(exit)) {
          yield* handle.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
        }
        yield* Effect.all([settle(stdout), settle(stderr)], { concurrency: 2 });
        const at = yield* Clock.currentTimeMillis;
        const ended: Ended = {
          exitCode:
            Option.isSome(exit) && exit.value._tag === "Success"
              ? Number(exit.value.success)
              : null,
          timedOut: Option.isNone(exit),
          at,
        };
        const waiting = yield* Ref.modify(task.state, (state): [number, TaskState] => [
          state.waiting,
          { ...state, ended: Option.some(ended) },
        ]);
        yield* Deferred.succeed(task.done, undefined);
        if (waiting === 0 && !(yield* Ref.get(task.stopped))) {
          yield* notices.post(task.owner.conversationId, yield* noticeFor(task, options.timeout));
        }
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logWarning(`background task ${task.id} did not end cleanly`, cause),
        ),
      );

    const start = Effect.fn("BackgroundTasks.start")(function* (options: TaskStartOptions) {
      const started = yield* starting.withPermits(1)(
        Effect.gen(function* () {
          yield* makeRoom;
          const id = yield* freshId;
          const stdoutFile = path.join(outputDir, `${id}.stdout.log`);
          const stderrFile = path.join(outputDir, `${id}.stderr.log`);
          // The files exist from the start, empty, so the paths the model gets are real.
          yield* Effect.gen(function* () {
            yield* fs.makeDirectory(outputDir, { recursive: true });
            yield* fs.writeFileString(stdoutFile, "", { flag: "w", mode: 0o600 });
            yield* fs.writeFileString(stderrFile, "", { flag: "w", mode: 0o600 });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`background task ${id}: output files not created`, cause),
            ),
          );
          const task: Task = {
            id,
            command: options.command,
            owner: options.owner,
            startedAt: yield* Clock.currentTimeMillis,
            stdoutFile,
            stderrFile,
            unread: { stdout: yield* Ref.make(EMPTY), stderr: yield* Ref.make(EMPTY) },
            handle: yield* Deferred.make<
              ChildProcessSpawner.ChildProcessHandle,
              PlatformError.PlatformError
            >(),
            state: yield* Ref.make<TaskState>({ waiting: 0, ended: Option.none() }),
            done: yield* Deferred.make<void>(),
            stopped: yield* Ref.make(false),
          };
          yield* Effect.forkIn(run(task, options), scope);
          // Whether it spawned is known at once; a task that never ran is not kept.
          const spawned = yield* Deferred.await(task.handle).pipe(Effect.result);
          if (spawned._tag === "Failure") {
            return yield* new TaskStartError({
              reason: "SpawnFailed",
              message: spawned.failure.message,
            });
          }
          yield* Ref.update(tasks, (all) => new Map(all).set(id, task));
          return task;
        }),
      );
      return yield* statusOf(started);
    });

    const output = Effect.fn("BackgroundTasks.output")(function* (
      taskId: string,
      principal: string,
      wait: Option.Option<number>,
    ) {
      const found = yield* find(taskId, principal);
      if (Option.isNone(found)) {
        return Option.none<TaskRead>();
      }
      const task = found.value;
      const waits =
        Option.isSome(wait) &&
        (yield* Ref.modify(task.state, (state): [boolean, TaskState] =>
          Option.isNone(state.ended)
            ? [true, { ...state, waiting: state.waiting + 1 }]
            : [false, state],
        ));
      if (waits && Option.isSome(wait)) {
        yield* Deferred.await(task.done).pipe(
          Effect.timeoutOption(wait.value),
          Effect.ensuring(
            Ref.update(task.state, (state) => ({ ...state, waiting: state.waiting - 1 })),
          ),
        );
      }
      const out = render(yield* Ref.getAndSet(task.unread.stdout, EMPTY), task.stdoutFile);
      const err = render(yield* Ref.getAndSet(task.unread.stderr, EMPTY), task.stderrFile);
      const status = yield* statusOf(task);
      return Option.some<TaskRead>({
        ...status,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    });

    const stop = Effect.fn("BackgroundTasks.stop")(function* (taskId: string, principal: string) {
      const found = yield* find(taskId, principal);
      if (Option.isNone(found)) {
        return Option.none<TaskStatus>();
      }
      const task = found.value;
      if (!(yield* Deferred.isDone(task.done))) {
        yield* Ref.set(task.stopped, true);
        // A kept task did spawn; the handle is there.
        const handle = yield* Deferred.await(task.handle).pipe(Effect.option);
        if (Option.isSome(handle)) {
          yield* handle.value.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
        }
        yield* Deferred.await(task.done);
      }
      return Option.some(yield* statusOf(task));
    });

    const list = Effect.fn("BackgroundTasks.list")(function* (
      principal: string,
      conversationId: Option.Option<string>,
    ) {
      const all = [...(yield* Ref.get(tasks)).values()]
        .filter(
          (task) =>
            task.owner.principal === principal &&
            Option.match(conversationId, {
              onNone: () => true,
              onSome: (id) => task.owner.conversationId === id,
            }),
        )
        .toSorted((a, b) => a.startedAt - b.startedAt);
      return yield* Effect.forEach(all, statusOf);
    });

    return BackgroundTasks.of({ start, output, stop, list });
  });

  static readonly layer = Layer.effect(BackgroundTasks, BackgroundTasks.make);
}
