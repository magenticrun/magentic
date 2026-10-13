import { describeRunTrace, summarizeTrace, toChromeTrace, toOtlpJson } from "@magentic/core";
import { CommandError, type CommandInput, define } from "@magentic/plugin";
import type { TraceSpan } from "@magentic/protocol";
import { Effect, FileSystem, Option, Path } from "effect";

const NAME = "trace";

/** The shapes a trace can be written in. */
export type TraceFormat = "summary" | "otlp" | "chrome";

/** The service name an export carries, as a collector files it. */
const SERVICE = "magentic-gateway";

/** The spans in one format, ready to print or write. A summary covers the latest `runs` runs. */
export const renderTrace = (
  spans: ReadonlyArray<TraceSpan>,
  format: TraceFormat,
  runs: number,
): string => {
  switch (format) {
    case "summary": {
      const summaries = summarizeTrace(spans).slice(-Math.max(1, runs));
      return summaries.length === 0
        ? "No traced runs in this conversation yet."
        : summaries.map(describeRunTrace).join("\n\n");
    }
    case "otlp":
      return JSON.stringify(toOtlpJson(spans, SERVICE));
    case "chrome":
      return JSON.stringify(toChromeTrace(spans));
  }
};

/** What each export subcommand writes, the file it names by default, and where to open it. */
const EXPORTS = {
  export: {
    format: "otlp",
    suffix: "otlp.json",
    hint: "OTLP JSON: POST it to a collector's /v1/traces, or upload it in Jaeger",
  },
  flame: {
    format: "chrome",
    suffix: "trace.json",
    hint: "a flame chart: open it at https://ui.perfetto.dev or https://www.speedscope.app",
  },
} as const;

const isExport = (word: string): word is keyof typeof EXPORTS => Object.hasOwn(EXPORTS, word);

const USAGE =
  "/trace [runs] shows the latest runs; /trace export or /trace flame [file] writes the whole trace as OTLP JSON or a Chrome trace";

/**
 * `/trace`: what this conversation's runs spent their time on. Bare, or with
 * a number, it summarises the latest runs in the transcript; `export` and
 * `flame` write every span to a file beside the chat, for a collector or
 * Perfetto. The agent reads the same traces
 * through its `session_trace` tool.
 */
export const traceCommandPlugin = define({
  id: "trace-command",
  description:
    "The /trace command: summarise this conversation's runs, or export their spans for a collector or a flame graph.",
  setup: Effect.fn("traceCommandPlugin.setup")(function* (ctx) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const run = Effect.fn("trace.run")(function* ({ ui, session, args }: CommandInput) {
      const [first = "", target] = args.split(/\s+/).filter((word) => word.length > 0);
      if (first === "" || /^\d+$/.test(first)) {
        const spans = yield* session.trace;
        const runs = first === "" ? 1 : Number(first);
        return yield* ui.notify(renderTrace(spans, "summary", runs));
      }
      if (!isExport(first)) {
        return yield* new CommandError({ command: NAME, message: USAGE });
      }
      const { format, suffix, hint } = EXPORTS[first];
      const spans = yield* session.trace;
      if (spans.length === 0) {
        return yield* ui.notify("No traced runs in this conversation yet.");
      }
      const id = Option.match(yield* session.conversation, {
        onNone: () => "conversation",
        onSome: (conversation) => conversation.id.slice(0, 8),
      });
      const file = path.resolve(ctx.paths.workspace, target ?? `magentic-trace-${id}.${suffix}`);
      yield* fs.writeFileString(file, renderTrace(spans, format, 0), { mode: 0o600 }).pipe(
        Effect.mapError(
          (error) =>
            new CommandError({
              command: NAME,
              message: `cannot write ${file}: ${error.message}`,
            }),
        ),
      );
      yield* ui.notify(`Wrote ${spans.length} spans to ${file}\n${hint}`);
    });

    yield* ctx.command.register({
      name: NAME,
      description:
        "Show how the latest runs spent their time, or export them: /trace [export|flame]",
      run,
    });
  }),
});
