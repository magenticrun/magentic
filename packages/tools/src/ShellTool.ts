import { Clock, Effect, Fiber, FileSystem, Option, Path, Ref, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CapabilityAnnotation } from "@magentic/plugin";
import { resolveWithin, WorkspaceRoot } from "./WorkspaceRoot.ts";

/** Returned to the model as a tool result, so the agent can pick another directory or report it. */
export class ShellToolError extends Schema.TaggedError<ShellToolError>()("ShellToolError", {
  reason: Schema.Literals(["OutsideWorkspace", "SpawnFailed"]),
  message: Schema.String,
}) {}

/** How long a command may run when the call does not say. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a call may ask for. */
export const MAX_TIMEOUT_MS = 600_000;
/** Characters of stdout or stderr the model gets back; the middle goes when there is more. */
export const OUTPUT_LIMIT = 30_000;
/** How long a timed-out command gets to exit on SIGTERM before SIGKILL. */
const FORCE_KILL_AFTER = "2 seconds";

/**
 * What a child inherits on top of the gateway's environment. Nothing here may
 * wait on a terminal: no pagers, no colour codes, no credential prompts.
 */
const CHILD_ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

export const Shell = Tool.make("shell", {
  description:
    "Run a shell command in the workspace and get back its exit code, stdout, and stderr. " +
    "Use it for git, package managers, tests, builds, and scripts. " +
    "Use read_file, grep, glob, list_dir, and edit_file for files rather than cat, grep, find, or sed. " +
    "The command runs through sh with no terminal and no stdin, so anything interactive fails or hangs: pass non-interactive flags. " +
    `A command is killed after ${DEFAULT_TIMEOUT_MS} ms unless timeout says otherwise, ${MAX_TIMEOUT_MS} ms at most, and comes back with timedOut set. ` +
    "Set workdir to run in a subdirectory instead of cd. " +
    `stdout and stderr are each cut in the middle past ${OUTPUT_LIMIT} characters and marked truncated; pipe through tail or grep when only part of the output matters. ` +
    "Chain dependent commands with && in one call; run independent commands as separate, parallel calls.",
  parameters: Schema.Struct({
    command: Schema.NonEmptyString.annotate({ description: "The command line to run" }),
    workdir: Schema.optional(
      Schema.String.annotate({
        description:
          "Directory to run in, relative to the workspace root; the root itself when omitted",
      }),
    ),
    timeout: Schema.optional(
      Schema.Int.annotate({
        description: `Milliseconds before the command is killed; default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}`,
      }),
    ),
  }),
  success: Schema.Struct({
    /** Null when the command was killed for running too long. */
    exitCode: Schema.NullOr(Schema.Int),
    stdout: Schema.String,
    stderr: Schema.String,
    truncated: Schema.Boolean,
    timedOut: Schema.Boolean,
    durationMs: Schema.Int,
  }),
  failure: ShellToolError,
  failureMode: "return",
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "shell");

export const ShellTools = Toolkit.make(Shell);

/** How long the readers may keep draining after the command ended before we take what they have. */
const COLLECT_GRACE = "2 seconds";

interface Captured {
  readonly text: string;
  readonly truncated: boolean;
}

/** Output kept while it streams: the first half, the last half, and how much fell between. */
interface Bounded {
  readonly head: string;
  readonly tail: string;
  readonly omitted: number;
}

const HALF = Math.floor(OUTPUT_LIMIT / 2);
const EMPTY: Bounded = { head: "", tail: "", omitted: 0 };

/** Whether the buffer is still one unbroken prefix, short of the limit. */
const whole = (buffer: Bounded): boolean => buffer.omitted === 0 && buffer.tail === "";

/** Appends a chunk, keeping at most `HALF` characters at each end. */
export const push = (buffer: Bounded, chunk: string): Bounded => {
  if (whole(buffer) && buffer.head.length + chunk.length <= OUTPUT_LIMIT) {
    return { ...buffer, head: buffer.head + chunk };
  }
  // Past the limit: a fixed head, and a tail that slides over everything after it.
  const joined = whole(buffer) ? buffer.head + chunk : buffer.tail + chunk;
  const head = whole(buffer) ? joined.slice(0, HALF) : buffer.head;
  const rest = whole(buffer) ? joined.slice(HALF) : joined;
  const tail = rest.slice(-HALF);
  const omitted = buffer.omitted + (rest.length - tail.length);
  return { head, tail, omitted };
};

/** The text the model sees, with a note where the middle was. */
export const render = (buffer: Bounded): Captured =>
  whole(buffer)
    ? { text: buffer.head, truncated: false }
    : {
        text: `${buffer.head}\n… ${buffer.omitted} characters omitted …\n${buffer.tail}`,
        truncated: true,
      };

const clampTimeout = (requested: number | undefined): number =>
  requested === undefined || requested <= 0
    ? DEFAULT_TIMEOUT_MS
    : Math.min(requested, MAX_TIMEOUT_MS);

/** Handlers for the shell tool. Needs a ChildProcessSpawner, a FileSystem, a Path, and a WorkspaceRoot. */
export const shellToolHandlers = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* WorkspaceRoot;

  const resolveWorkdir = Effect.fn("ShellTool.resolveWorkdir")(function* (
    requested: string | undefined,
  ) {
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
    return resolved.value.absolute;
  });

  const spawnFailed = (error: { readonly message: string }) =>
    new ShellToolError({ reason: "SpawnFailed", message: error.message });

  return ShellTools.of({
    shell: Effect.fn("ShellTool.shell")(function* ({ command, workdir, timeout }) {
      const cwd = yield* resolveWorkdir(workdir);
      const limit = clampTimeout(timeout);
      const started = yield* Clock.currentTimeMillis;
      return yield* Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(command, {
              shell: true,
              cwd,
              env: CHILD_ENV,
              extendEnv: true,
              stdin: "ignore",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )
          .pipe(Effect.mapError(spawnFailed));
        // Drain both pipes while the command runs, or a chatty one blocks on a full pipe.
        // Each chunk lands in a Ref, so what was read survives interrupting the reader.
        const collect = (stream: Stream.Stream<Uint8Array, { readonly message: string }>) =>
          Effect.gen(function* () {
            const buffer = yield* Ref.make(EMPTY);
            const reader = yield* Effect.forkChild(
              stream.pipe(
                Stream.decodeText(),
                Stream.runForEach((chunk) => Ref.update(buffer, (b) => push(b, chunk))),
                Effect.mapError(spawnFailed),
              ),
            );
            return { buffer, reader };
          });
        const stdout = yield* collect(handle.stdout);
        const stderr = yield* collect(handle.stderr);
        const exit = yield* handle.exitCode.pipe(
          Effect.mapError(spawnFailed),
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
            return render(yield* Ref.get(collector.buffer));
          });
        const [out, err] = yield* Effect.all([settle(stdout), settle(stderr)], { concurrency: 2 });
        const finished = yield* Clock.currentTimeMillis;
        return {
          exitCode: Option.isSome(exit) ? Number(exit.value) : null,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timedOut: Option.isNone(exit),
          durationMs: finished - started,
        };
      }).pipe(Effect.scoped);
    }),
  });
});

export const ShellToolsLayer = ShellTools.toLayer(shellToolHandlers);
