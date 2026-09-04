import { describeInterval, parseInterval } from "@magentic/core";
import { CommandError, type CommandInput, define } from "@magentic/plugin";
import type { ScheduledTask } from "@magentic/protocol";
import { DateTime, Effect, Option, Result } from "effect";
import { ago } from "./Conversations.ts";

const NAME = "loop";

const USAGE = [
  "/loop <interval> <what to do>   e.g. /loop 10m check the deploy",
  "/loop <what to do> every <interval>",
  "/loop status                   what is repeating now",
  "/loop stop [id|all]            stop one, or all of them",
].join("\n");

/** `in 9m`, `in 45s`, `in 7 days`: how long until something, for a person watching. */
const until = (at: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)) / 1000;
  if (seconds < 60) {
    return `in ${Math.max(1, Math.round(seconds))}s`;
  }
  if (seconds < 3600) {
    return `in ${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `in ${Math.round(seconds / 3600)}h`;
  }
  const days = Math.round(seconds / 86_400);
  return `in ${days} day${days === 1 ? "" : "s"}`;
};

const live = (task: ScheduledTask) => task.phase !== "ended";

/** One task on one line, wide enough to tell two loops apart at a glance. */
const describe = (task: ScheduledTask, now: DateTime.Utc): string => {
  const next = Option.match(Option.fromNullishOr(task.nextFireAt), {
    onNone: () => task.endedReason ?? "ended",
    onSome: (at) => `next ${until(at, now)}`,
  });
  const ran =
    task.runCount === 0
      ? "not yet run"
      : `${task.runCount} run${task.runCount === 1 ? "" : "s"}` +
        Option.match(Option.fromNullishOr(task.lastRunAt), {
          onNone: () => "",
          onSome: (at) => `, last ${ago(at, now)}`,
        });
  return `${task.id}  every ${describeInterval(task.intervalMillis)} · ${next} · ${ran}\n      ${task.prompt}`;
};

const status = Effect.fn("loop.status")(function* ({ ui, session }: CommandInput) {
  const tasks = (yield* session.schedules.list).filter(live);
  if (tasks.length === 0) {
    return yield* ui.notify(`Nothing is repeating.\n\n${USAGE}`);
  }
  const now = yield* DateTime.now;
  yield* ui.notify(
    [
      `Repeating (${tasks.length}); /loop stop <id> to stop one`,
      ...tasks.map((task) => describe(task, now)),
    ].join("\n"),
  );
});

const stop = Effect.fn("loop.stop")(function* ({ ui, session, args }: CommandInput) {
  const target = args.trim();
  if (target === "all") {
    const stopped = yield* session.schedules.removeAll;
    return yield* ui.notify(stopped === 0 ? "Nothing was repeating." : `Stopped ${stopped} loops.`);
  }
  if (target.length > 0) {
    return (yield* session.schedules.remove(target))
      ? yield* ui.notify(`Stopped loop ${target}.`)
      : yield* new CommandError({ command: NAME, message: `No loop ${target} on this chat.` });
  }
  const tasks = (yield* session.schedules.list).filter(live);
  if (tasks.length === 0) {
    return yield* ui.notify("Nothing is repeating.");
  }
  // One loop is unambiguous. Several are not, and guessing which to stop is
  // worse than saying which there are.
  const only = tasks.length === 1 ? tasks[0] : undefined;
  if (only !== undefined) {
    yield* session.schedules.remove(only.id);
    return yield* ui.notify(`Stopped loop ${only.id}.`);
  }
  const now = yield* DateTime.now;
  yield* ui.notify(
    [
      `${tasks.length} loops are repeating; say which, or /loop stop all`,
      ...tasks.map((task) => describe(task, now)),
    ].join("\n"),
  );
});

/** What to repeat and how often, and what the reader made of the words when one was asked. */
interface Asked {
  readonly intervalMillis: number;
  readonly prompt: string;
  readonly until: Option.Option<DateTime.Utc>;
  /** What the model took the words to mean; none when the parser here read them. */
  readonly interpretation: Option.Option<string>;
}

/**
 * `5m` and `every 20 minutes` are read here: no round trip, and the same
 * answer every time. Anything else — `twice an hour`, `until 3pm` — goes to a
 * model, which reads the intent while the times are still worked out from a
 * real clock on the other side.
 *
 * A cadence the parser read and then refused does not go to the model. `10s`
 * is not ambiguous, it is too often, and no rewording of it gets past a bound
 * this side enforces; asking anyway spends a round trip that can only come
 * back with the same answer or with the model's own trouble in place of the
 * real reason.
 */
const read = Effect.fn("loop.read")(function* ({ session, args }: CommandInput) {
  const parsed = parseInterval(args);
  if (Result.isSuccess(parsed)) {
    const asked: Asked = {
      intervalMillis: parsed.success.intervalMillis,
      prompt: parsed.success.rest,
      until: Option.none(),
      interpretation: Option.none(),
    };
    return asked;
  }
  if (parsed.failure.settled) {
    return yield* new CommandError({
      command: NAME,
      message: `${parsed.failure.message}.\n\n${USAGE}`,
    });
  }
  const heard = yield* session.schedules.read(args);
  const asked: Asked = {
    intervalMillis: heard.intervalMillis,
    prompt: heard.prompt,
    until: Option.fromNullishOr(heard.until),
    interpretation: Option.some(heard.interpretation),
  };
  return asked;
});

const start = Effect.fn("loop.start")(function* (input: CommandInput) {
  const asked = yield* read(input);
  if (asked.prompt.length === 0) {
    return yield* new CommandError({
      command: NAME,
      message: `Say what to do every ${describeInterval(asked.intervalMillis)}.\n\n${USAGE}`,
    });
  }
  // Stored and armed before this says so: a confirmation for a loop that was
  // not written would be a lie the next restart exposes.
  const task = yield* input.session.schedules.create({
    prompt: asked.prompt,
    intervalMillis: asked.intervalMillis,
    until: Option.getOrUndefined(asked.until),
  });
  const now = yield* DateTime.now;
  const next = Option.match(Option.fromNullishOr(task.nextFireAt), {
    onNone: () => "",
    onSome: (at) => `, first ${until(at, now)}`,
  });
  const ends = Option.match(asked.until, {
    onNone: () => `Expires ${until(task.expiresAt, now)}.`,
    onSome: (at) => `Stops ${until(at, now)}.`,
  });
  // What the model made of the words goes beside the times worked out from
  // the clock, so a misreading shows now rather than an hour from now.
  const heard = Option.match(asked.interpretation, {
    onNone: () => [],
    onSome: (words) => [`Read as: ${words}`],
  });
  yield* input.ui.notify(
    [
      `Looping every ${describeInterval(task.intervalMillis)}${next}. ${ends}`,
      ...heard,
      `  ${task.prompt}`,
      `Stop it with /loop stop ${task.id}, or esc while nothing is running.`,
    ].join("\n"),
  );
});

/**
 * `/loop`: repeat an input on this conversation until it is stopped.
 *
 * A tick is a turn of its own. It waits for whatever is running to finish
 * rather than interrupting it, and it only runs while a surface is following
 * the conversation — a model call nobody is watching is not worth its cost.
 */
const run = Effect.fn("loop.run")(function* (input: CommandInput) {
  const args = input.args.trim();
  if (args.length === 0 || args === "status") {
    return yield* status(input);
  }
  if (args === "stop" || args.startsWith("stop ")) {
    return yield* stop({ ...input, args: args.slice("stop".length) });
  }
  yield* start({ ...input, args });
});

export const loopCommandPlugin = define({
  id: "loop-command",
  description: "The /loop command: repeat an input on a schedule until it is stopped.",
  setup: Effect.fn("loopCommandPlugin.setup")(function* (ctx) {
    yield* ctx.command.register({
      name: NAME,
      description: "Repeat an input on a schedule: /loop 10m check the deploy",
      run,
    });
  }),
});
