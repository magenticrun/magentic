import { Clock, Effect, Fiber, FileSystem, Option, Path, Ref, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CapabilityAnnotation, ToolCallContext } from "@magentic/plugin";
import { BackgroundTask, type Principal } from "@magentic/protocol";
import { BackgroundTasks, MAX_TASKS } from "./BackgroundTasks.ts";
import { EMPTY, OUTPUT_LIMIT, push, render, ToolOutputDir, whole } from "./ToolOutput.ts";
import { resolveWithin, WorkspaceRoot } from "./WorkspaceRoot.ts";

/** Returned to the model as a tool result, so the agent can pick another directory or report it. */
export class ShellToolError extends Schema.TaggedError<ShellToolError>()("ShellToolError", {
  reason: Schema.Literals([
    "OutsideWorkspace",
    "NoSuchWorkdir",
    "SpawnFailed",
    "NoSuchTask",
    "TaskLimit",
  ]),
  message: Schema.String,
}) {}

/** How long a command may run when the call does not say. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a foreground call may ask for. */
export const MAX_TIMEOUT_MS = 600_000;
/** How long `task_output` waits for a task to end when the call does not say. */
export const DEFAULT_WAIT_MS = 30_000;
/** The longest `task_output` may wait. */
export const MAX_WAIT_MS = 600_000;
/** How long a timed-out command gets to exit on SIGTERM before SIGKILL. */
const FORCE_KILL_AFTER = "2 seconds";

/**
 * What a child inherits on top of the gateway's environment. Nothing here may
 * wait on a terminal: no pagers, no colour codes, no credential prompts. And
 * nothing here may act as the operator: the tokens `gh` and `git` read from
 * the environment are blanked, so a model that runs `gh pr create` is not
 * the person who started the gateway. A helper that answered `git
 * credential fill` would put a token on the model's screen, so no askpass
 * either; a bridge's tools push with their own token, in process.
 */
const CHILD_ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  GIT_ASKPASS: "",
};

/**
 * The environment for one call. A machine principal acting for a person, a
 * bridge run, does not see the operator's `gh` login either: its config
 * directory is pointed at one that holds no account. A person at the CLI
 * keeps theirs, since their own shell has it already.
 */
const envFor = (principal: Principal, outputDir: string): Record<string, string> =>
  principal.onBehalfOf === undefined
    ? CHILD_ENV
    : { ...CHILD_ENV, GH_CONFIG_DIR: `${outputDir}/gh-config-isolated` };

/** A command that ran to its end, or was killed for running too long. */
const Finished = Schema.Struct({
  /** Null when the command did not exit on its own: killed for running too long, or by a signal. */
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  /** Where the whole stdout was saved; present only when stdout was cut. */
  stdoutFile: Schema.optional(Schema.String),
  /** Where the whole stderr was saved; present only when stderr was cut. */
  stderrFile: Schema.optional(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Int,
});

/** A command left running in the background. */
const Started = Schema.Struct({
  taskId: Schema.String,
  command: Schema.String,
  /** Where the whole of each stream goes, from the start. */
  stdoutFile: Schema.String,
  stderrFile: Schema.String,
  message: Schema.String,
});

/** The same shape a surface gets from `listTasks`, so the two never drift. */
const TaskStatus = BackgroundTask;

/** A task as `task_stop` and `task_list` report it: without the output files, which `task_output` names. */
const TaskSummary = Schema.Struct({
  taskId: BackgroundTask.fields.taskId,
  command: BackgroundTask.fields.command,
  running: BackgroundTask.fields.running,
  exitCode: BackgroundTask.fields.exitCode,
  timedOut: BackgroundTask.fields.timedOut,
  stopped: BackgroundTask.fields.stopped,
  durationMs: BackgroundTask.fields.durationMs,
});

const summarise = (status: typeof TaskStatus.Type): typeof TaskSummary.Type => ({
  taskId: status.taskId,
  command: status.command,
  running: status.running,
  exitCode: status.exitCode,
  timedOut: status.timedOut,
  stopped: status.stopped,
  durationMs: status.durationMs,
});

const TaskOutputResult = Schema.Struct({
  ...TaskStatus.fields,
  /** What arrived since the last task_output call for this task. */
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
});

export const Shell = Tool.make("shell", {
  description:
    "Run a shell command in the workspace and get back its exit code, stdout, and stderr. " +
    "Use it for git, package managers, tests, builds, and scripts. " +
    "Use read_file, grep, glob, list_dir, and edit_file for files rather than cat, grep, find, or sed. " +
    "The command runs through sh with no terminal and no stdin, so anything interactive fails or hangs: pass non-interactive flags. " +
    `A command is killed after ${DEFAULT_TIMEOUT_MS} ms unless timeout says otherwise, ${MAX_TIMEOUT_MS} ms at most, and comes back with timedOut set. ` +
    "Set workdir to run in a subdirectory instead of cd. " +
    `stdout and stderr are each cut in the middle past ${OUTPUT_LIMIT} characters and marked truncated; the whole of a cut stream is saved to the file stdoutFile or stderrFile names, outside the workspace, for grep, sed -n, or tail through this tool. ` +
    "Chain dependent commands with && in one call; run independent commands as separate, parallel calls. " +
    "Set background to true for a command that should keep running while you work, a dev server or a long test run: " +
    "the call returns at once with a taskId, task_output reads what it has printed since and can wait for it to end, and task_stop ends it. " +
    "When a background task ends and nothing is waiting on it you are told before your next reply, so do not poll. " +
    "A background command has no timeout unless the call gives one.",
  parameters: Schema.Struct({
    command: Schema.NonEmptyString.annotate({ description: "The command line to run" }),
    workdir: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Directory to run in, relative to the workspace root; the root itself when omitted",
      }),
    ),
    timeout: Schema.optionalKey(
      Schema.Int.annotate({
        description: `Milliseconds before the command is killed; default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}. No default in the background`,
      }),
    ),
    background: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Leave the command running and return its taskId at once",
      }),
    ),
  }),
  success: Schema.Union([Finished, Started]),
  failure: ShellToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "shell");

export const TaskOutput = Tool.make("task_output", {
  description:
    "What a background task started by shell has printed since you last read it, with whether it is still running and, once it is not, its exit code. " +
    `Waits up to timeout milliseconds for the task to end first, ${DEFAULT_WAIT_MS} by default and ${MAX_WAIT_MS} at most; set wait to false to look without waiting. ` +
    "Each stream is cut in the middle past the usual limit; the whole of it is in stdoutFile and stderrFile, for grep, sed -n, or tail through shell.",
  parameters: Schema.Struct({
    taskId: Schema.NonEmptyString.annotate({ description: "The task, as shell returned it" }),
    wait: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Whether to wait for the task to end; true when omitted",
      }),
    ),
    timeout: Schema.optionalKey(
      Schema.Int.annotate({
        description: `Milliseconds to wait at most; default ${DEFAULT_WAIT_MS}, at most ${MAX_WAIT_MS}`,
      }),
    ),
  }),
  success: TaskOutputResult,
  failure: ShellToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "shell");

export const TaskStop = Tool.make("task_stop", {
  description:
    "End a background task started by shell: SIGTERM, then SIGKILL two seconds later. " +
    "Returns once the process is gone. Ending a task that has already ended changes nothing.",
  parameters: Schema.Struct({
    taskId: Schema.NonEmptyString.annotate({ description: "The task, as shell returned it" }),
  }),
  success: TaskSummary,
  failure: ShellToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "shell");

export const TaskList = Tool.make("task_list", {
  description:
    "The background tasks shell started in this conversation, oldest first, running or ended, with each one's taskId for task_output and task_stop. " +
    "Use it when you no longer have a task's id, after a compaction for one, or to see what is still running before you finish.",
  parameters: Schema.Struct({
    running: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Only the tasks still running; every task, ended ones too, when omitted",
      }),
    ),
  }),
  success: Schema.Array(TaskSummary),
  failure: ShellToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "shell");

export const ShellTools = Toolkit.make(Shell, TaskOutput, TaskStop, TaskList);

/** How long the readers may keep draining after the command ended before we take what they have. */
const COLLECT_GRACE = "2 seconds";

/** What a model sends for a workdir it meant to leave out. */
const NULLISH = new Set(["", "null", "undefined", "none"]);

const clampTimeout = (requested: number | undefined): number =>
  requested === undefined || requested <= 0
    ? DEFAULT_TIMEOUT_MS
    : Math.min(requested, MAX_TIMEOUT_MS);

const clampWait = (requested: number | undefined): number =>
  requested === undefined || requested <= 0 ? DEFAULT_WAIT_MS : Math.min(requested, MAX_WAIT_MS);

const noSuchTask = (taskId: string) =>
  new ShellToolError({
    reason: "NoSuchTask",
    message: `no background task ${taskId}; it may never have started, or ${MAX_TASKS} newer ones pushed it out`,
  });

/** Handlers for the shell tools. Needs a ChildProcessSpawner, a FileSystem, a Path, a WorkspaceRoot, a ToolOutputDir, and the BackgroundTasks. */
export const shellToolHandlers = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* WorkspaceRoot;
  const outputDir = yield* ToolOutputDir;
  const tasks = yield* BackgroundTasks;

  const isDirectory = (absolute: string) =>
    fs.stat(absolute).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const resolveWorkdir = Effect.fn("ShellTool.resolveWorkdir")(function* (
    requested: string | undefined,
  ) {
    // Some models send the string "null" for an optional they mean to leave
    // out. Unless a directory of that name is really there, that is the root,
    // rather than a failed call and another model call to correct it.
    if (
      requested !== undefined &&
      NULLISH.has(requested.trim()) &&
      !(yield* isDirectory(path.resolve(root, requested)))
    ) {
      return root;
    }
    const resolved = yield* resolveWithin(root, requested ?? ".").pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (error) => new ShellToolError({ reason: "SpawnFailed", message: error.message }),
      ),
    );
    if (Option.isNone(resolved)) {
      return yield* new ShellToolError({
        reason: "OutsideWorkspace",
        message: `${requested} is outside the workspace`,
      });
    }
    // A directory that is not there fails here, by name, rather than as the
    // spawn's complaint about an absolute path the model never saw.
    if (!(yield* isDirectory(resolved.value.absolute))) {
      return yield* new ShellToolError({
        reason: "NoSuchWorkdir",
        message: `workdir ${JSON.stringify(requested)} is not a directory in the workspace; omit it to run at the root`,
      });
    }
    return resolved.value.absolute;
  });

  const spawnFailed = (error: { readonly message: string }) =>
    new ShellToolError({ reason: "SpawnFailed", message: error.message });

  /** Start the command in the background for the caller, and say how to follow it. */
  const startTask = Effect.fn("ShellTool.startTask")(function* (
    command: string,
    cwd: string,
    timeout: number | undefined,
  ) {
    const call = yield* ToolCallContext;
    const started = yield* tasks
      .start({
        command,
        cwd,
        env: envFor(call.principal, outputDir),
        timeout: timeout === undefined || timeout <= 0 ? Option.none() : Option.some(timeout),
        owner: { principal: call.principal.id, conversationId: call.conversationId },
      })
      .pipe(
        Effect.mapError(
          (error) => new ShellToolError({ reason: error.reason, message: error.message }),
        ),
      );
    const result: typeof Started.Type = {
      taskId: started.taskId,
      command: started.command,
      stdoutFile: started.stdoutFile,
      stderrFile: started.stderrFile,
      message:
        `Running in the background as task ${started.taskId}. Carry on with other work; ` +
        "you will be told when it ends. task_output reads its output, task_stop ends it.",
    };
    return result;
  });

  const runForeground = Effect.fn("ShellTool.runForeground")(function* (
    command: string,
    cwd: string,
    timeout: number | undefined,
  ) {
    const limit = clampTimeout(timeout);
    const started = yield* Clock.currentTimeMillis;
    const call = yield* ToolCallContext;
    return yield* Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command, {
            shell: true,
            cwd,
            env: envFor(call.principal, outputDir),
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        )
        .pipe(Effect.mapError(spawnFailed));
      const callId = crypto.randomUUID();
      // Drain both pipes while the command runs, or a chatty one blocks on a full pipe.
      // Each chunk lands in a Ref, so what was read survives interrupting the reader.
      // Once a stream passes the limit, all of it goes to a file too, from the start.
      const collect = (
        stream: Stream.Stream<Uint8Array, { readonly message: string }>,
        name: "stdout" | "stderr",
      ) =>
        Effect.gen(function* () {
          const buffer = yield* Ref.make(EMPTY);
          const file = path.join(outputDir, `${callId}.${name}.log`);
          const saved = yield* Ref.make(false);
          // A file that cannot be written loses nothing the model would have seen.
          const save = (text: string, flag: "w" | "a") =>
            Effect.gen(function* () {
              if (flag === "w") {
                yield* fs.makeDirectory(outputDir, { recursive: true });
              }
              yield* fs.writeFileString(file, text, { flag, mode: 0o600 });
              yield* Ref.set(saved, true);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`shell: output of ${callId} not saved to ${file}`, cause),
              ),
            );
          const reader = yield* Effect.forkChild(
            stream.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  const before = yield* Ref.getAndUpdate(buffer, (b) => push(b, chunk));
                  if (whole(push(before, chunk))) {
                    return;
                  }
                  yield* whole(before) ? save(before.head + chunk, "w") : save(chunk, "a");
                }),
              ),
              Effect.mapError(spawnFailed),
            ),
          );
          return { buffer, reader, file, saved };
        });
      const stdout = yield* collect(handle.stdout, "stdout");
      const stderr = yield* collect(handle.stderr, "stderr");
      // A child a signal killed has no exit code, which the spawner reports
      // as a failure; what the command wrote before that still comes back.
      const exit = yield* handle.exitCode.pipe(
        Effect.tapError((error) =>
          Effect.logDebug(`shell: no exit code for ${callId}: ${error.message}`),
        ),
        Effect.result,
        Effect.timeoutOption(limit),
      );
      if (Option.isNone(exit)) {
        yield* handle.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
      }
      /** Wait for a reader to finish; past the grace period take what it has and stop it. */
      const settle = (collector: typeof stdout) =>
        Effect.gen(function* () {
          const done = yield* Fiber.join(collector.reader).pipe(
            Effect.ignore,
            Effect.timeoutOption(COLLECT_GRACE),
          );
          if (Option.isNone(done)) {
            yield* Fiber.interrupt(collector.reader);
          }
          const savedAs = (yield* Ref.get(collector.saved)) ? collector.file : undefined;
          return { ...render(yield* Ref.get(collector.buffer), savedAs), savedAs };
        });
      const [out, err] = yield* Effect.all([settle(stdout), settle(stderr)], { concurrency: 2 });
      const finished = yield* Clock.currentTimeMillis;
      const result: typeof Finished.Type = {
        exitCode:
          Option.isSome(exit) && exit.value._tag === "Success" ? Number(exit.value.success) : null,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut: Option.isNone(exit),
        durationMs: finished - started,
      };
      const withStdout =
        out.savedAs === undefined ? result : { ...result, stdoutFile: out.savedAs };
      return err.savedAs === undefined ? withStdout : { ...withStdout, stderrFile: err.savedAs };
    }).pipe(Effect.scoped);
  });

  return ShellTools.of({
    shell: Effect.fn("ShellTool.shell")(function* ({ command, workdir, timeout, background }) {
      const cwd = yield* resolveWorkdir(workdir);
      return yield* background === true
        ? startTask(command, cwd, timeout)
        : runForeground(command, cwd, timeout);
    }),
    task_output: Effect.fn("ShellTool.taskOutput")(function* ({ taskId, wait, timeout }) {
      const call = yield* ToolCallContext;
      const found = yield* tasks.output(
        taskId,
        call.principal.id,
        wait === false ? Option.none() : Option.some(clampWait(timeout)),
      );
      if (Option.isNone(found)) {
        return yield* noSuchTask(taskId);
      }
      return found.value;
    }),
    task_stop: Effect.fn("ShellTool.taskStop")(function* ({ taskId }) {
      const call = yield* ToolCallContext;
      const found = yield* tasks.stop(taskId, call.principal.id);
      if (Option.isNone(found)) {
        return yield* noSuchTask(taskId);
      }
      return summarise(found.value);
    }),
    task_list: Effect.fn("ShellTool.taskList")(function* ({ running }) {
      const call = yield* ToolCallContext;
      const all = yield* tasks.list(call.principal.id, Option.some(call.conversationId));
      return (running === true ? all.filter((task) => task.running) : all).map(summarise);
    }),
  });
});

export const ShellToolsLayer = ShellTools.toLayer(shellToolHandlers);
