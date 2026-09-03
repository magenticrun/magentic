import { Schema } from "effect";

/** A command `shell` left running in the background, as the tools and the surfaces see it. */
export const BackgroundTask = Schema.Struct({
  taskId: Schema.String,
  command: Schema.String,
  running: Schema.Boolean,
  /** Null while running, and when it did not exit on its own: stopped, timed out, or killed by a signal. */
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  /** Whether `task_stop` ended it. */
  stopped: Schema.Boolean,
  /** How long it ran, or has been running. */
  durationMs: Schema.Int,
  /** Where the whole of each stream is, from the start. */
  stdoutFile: Schema.String,
  stderrFile: Schema.String,
});
export type BackgroundTask = typeof BackgroundTask.Type;
