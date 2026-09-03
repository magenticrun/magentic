import { describeCause } from "@magentic/core";
import { RunEvent } from "@magentic/protocol";
import { Cause, Console, Effect, Option, Ref, Schema, Stream, Terminal } from "effect";
import type { Message } from "./Attachments.ts";
import { ensureGateway } from "./Gateway.ts";
import { Reported } from "./Reported.ts";
import { pickUp, type PickUpOptions } from "./Resume.ts";

/**
 * `text` prints the reply on stdout as it streams, with tool calls and the
 * rest of the run's progress on stderr, so the reply alone reaches a pipe.
 * `json` prints every run event on stdout, one JSON object per line, in the
 * shape `RunEvent` has on the wire; `RunStarted` carries the conversation id
 * to continue from.
 */
export type OutputMode = "text" | "json";

export interface PrintOptions extends PickUpOptions {
  readonly baseUrl: string;
  /** The message from the arguments; what is piped in on stdin follows it. */
  readonly message: Message;
  /** A `provider/model` to run on instead of the agent's own. */
  readonly model: Option.Option<string>;
  /** One of the model's thinking levels; absent for its default. */
  readonly thinking: Option.Option<string>;
  readonly mode: OutputMode;
}

/** Enough of a tool's arguments or result to follow along; the full value is in the JSON mode. */
const summarise = (value: Schema.Json): string => {
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/**
 * What was piped in, when stdin is a pipe or a file rather than the
 * terminal. Read whole: the input is one message, not a stream of them.
 */
const piped = Effect.gen(function* () {
  if (process.stdin.isTTY === true) {
    return Option.none<string>();
  }
  const text = yield* Effect.promise(() => Bun.stdin.text());
  return text.trim().length === 0 ? Option.none<string>() : Option.some(text.trimEnd());
});

/** The arguments' message, then what was piped in, either alone when the other is missing. */
const resolveInput = Effect.fn("Cli.print.resolveInput")(function* (given: string) {
  const stdin = yield* piped;
  const parts = [given, ...Option.toArray(stdin)].filter((part) => part.trim().length > 0);
  return parts.length === 0 ? Option.none<string>() : Option.some(parts.join("\n\n"));
});

/** One event as the gateway would put it on the wire, on one line. */
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(RunEvent));

/**
 * Print mode, as pi's `-p`: one message, one run, the reply printed, then
 * exit. For pipes, scripts, CI, and anything that invokes magentic rather
 * than a person. The exit code is 1 when the run fails, or cannot start;
 * what went wrong is on stderr (or, in `json` mode, a final `RunFailed`
 * line on stdout).
 */
export const print = Effect.fn("Cli.print")(function* (options: PrintOptions) {
  const terminal = yield* Terminal.Terminal;
  const json = options.mode === "json";

  const failed = Effect.fn("Cli.print.failed")(function* (message: string) {
    if (json) {
      yield* Console.log(encodeEvent({ _tag: "RunFailed", message }));
    } else {
      yield* Console.error(`run failed: ${message}`);
    }
    return yield* new Reported({ message });
  });

  const resolved = yield* resolveInput(options.message.text).pipe(Effect.exit);
  if (resolved._tag === "Failure") {
    if (Cause.hasInterruptsOnly(resolved.cause)) {
      return yield* Effect.failCause(resolved.cause);
    }
    return yield* failed(describeCause(resolved.cause));
  }
  const input = resolved.value;
  if (Option.isNone(input)) {
    return yield* failed("nothing to send; pass a message as an argument or pipe it on stdin");
  }

  const started = yield* Effect.gen(function* () {
    const { client } = yield* ensureGateway(options.baseUrl);
    const { agent, starting } = yield* pickUp(client, options);
    return { client, agent, starting };
  }).pipe(Effect.exit);
  if (started._tag === "Failure") {
    if (Cause.hasInterruptsOnly(started.cause)) {
      return yield* Effect.failCause(started.cause);
    }
    return yield* failed(describeCause(started.cause));
  }
  const { client, agent, starting } = started.value;

  // Text mode ends the reply with a newline when the model did not, so the
  // prompt (or the next line of a log) starts on its own line.
  const atLineStart = yield* Ref.make(true);
  const runFailed = yield* Ref.make(false);

  const printText = (event: RunEvent) => {
    switch (event._tag) {
      case "RunStarted":
      case "ReasoningDelta":
      case "TokenUsage":
      case "CompactionStarted":
      case "Steered":
        return Effect.void;
      case "Compacted":
        return Console.error(`(compacted ${event.messagesBefore} messages into a summary)`);
      case "Retrying":
        return Console.error(
          `(${event.message}; retrying in ${Math.ceil(event.delayMs / 1000)}s, ${event.attempt} of ${event.limit})`,
        );
      case "TextDelta":
        if (event.text.length === 0) {
          return Effect.void;
        }
        return Ref.set(atLineStart, event.text.endsWith("\n")).pipe(
          Effect.andThen(terminal.display(event.text).pipe(Effect.orDie)),
        );
      case "ToolCall":
        return Console.error(`→ ${event.name} ${summarise(event.params)}`);
      case "ToolResult":
        return Console.error(
          `← ${event.name} ${event.isFailure ? "failed" : "ok"} ${summarise(event.result)}`,
        );
      case "RunFinished":
        return Effect.gen(function* () {
          if (!(yield* Ref.get(atLineStart))) {
            yield* terminal.display("\n").pipe(Effect.orDie);
          }
          if (event.reason === "step-limit") {
            yield* Console.error(
              "(stopped at the agent's step limit; send another message to continue)",
            );
          }
        });
      case "RunFailed":
        return Ref.set(runFailed, true).pipe(
          Effect.andThen(Console.error(`run failed: ${event.message}`)),
        );
    }
  };

  const printJson = (event: RunEvent) =>
    Ref.update(runFailed, (already) => already || event._tag === "RunFailed").pipe(
      Effect.andThen(Console.log(encodeEvent(event))),
    );

  const { attachments } = options.message;
  const events = client.run({
    agent: agent.name,
    input: input.value,
    attachments: attachments.length > 0 ? attachments : undefined,
    conversationId: Option.getOrUndefined(Option.map(starting, (c) => c.id)),
    model: Option.getOrUndefined(options.model),
    reasoning: Option.getOrUndefined(options.thinking),
    directory: process.cwd(),
  });
  const streamed = yield* Stream.runForEach(events, json ? printJson : printText).pipe(Effect.exit);
  if (streamed._tag === "Failure") {
    if (Cause.hasInterruptsOnly(streamed.cause)) {
      return yield* Effect.failCause(streamed.cause);
    }
    return yield* failed(describeCause(streamed.cause));
  }
  if (yield* Ref.get(runFailed)) {
    return yield* new Reported({ message: "run failed" });
  }
}, Effect.scoped);
