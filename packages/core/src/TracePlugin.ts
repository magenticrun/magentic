import { CapabilityAnnotation, define, ToolCallContext } from "@magentic/plugin";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { RunTrace, summarizeTrace } from "./TraceReport.ts";
import { TraceStore } from "./TraceStore.ts";

/** Runs one call may ask for; past this the answer is more than a model reads well. */
const MAX_RUNS = 10;

export const SessionTrace = Tool.make("session_trace", {
  description:
    "How this conversation's earlier runs spent their time and tokens, from the gateway's traces. " +
    "Each run gives its duration and outcome, and findings: what stood out, such as the prompt cache missing, a slow first output, retries, or a tool failing again and again. " +
    "Then the detail: time spent waiting on the model, in tools, and elsewhere; " +
    "every model call with its latency, time to first output, tokens, cache hits, cost, and retries; " +
    "each tool's calls, total and longest time, failures with the latest error, and refusals with the reason; the operations that took the most time; and any errors. " +
    "Use it when asked why something was slow, costly, or failed, or to check how your own work went before changing approach.",
  parameters: Schema.Struct({
    runs: Schema.optionalKey(
      Schema.Int.annotate({
        description: `How many of the latest finished runs, oldest first; 1 when omitted, at most ${MAX_RUNS}`,
      }),
    ),
    current: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Also the run you are in now, up to what has finished in it; only earlier runs when omitted",
      }),
    ),
  }),
  success: Schema.Struct({
    runs: Schema.Array(RunTrace),
    /** Said when there is nothing to show, so an empty list is not read as a fast run. */
    note: Schema.optionalKey(Schema.String),
  }),
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "trace:read");

const SessionTraceTools = Toolkit.make(SessionTrace);

/**
 * `session_trace`: an agent reading its own conversation's traces, the same
 * ones `/trace` exports. Only the calling conversation's: the tool takes no
 * id, so it cannot reach anyone else's.
 */
export const traceToolPlugin = define<TraceStore>({
  id: "session-trace",
  description: "The session_trace tool: how this conversation's runs spent their time and tokens.",
  setup: Effect.fn("traceToolPlugin.setup")(function* (ctx) {
    const store = yield* TraceStore;
    const handlers = yield* SessionTraceTools.toHandlers(
      SessionTraceTools.of({
        session_trace: Effect.fn("SessionTrace.handle")(function* ({ runs, current }) {
          const call = yield* ToolCallContext;
          const all = summarizeTrace(yield* store.spans(call.conversationId));
          const wanted = Math.min(MAX_RUNS, Math.max(1, runs ?? 1));
          const earlier = all.filter((run) => run.runId !== call.runId && !run.inFlight);
          const now = current === true ? all.filter((run) => run.runId === call.runId) : [];
          const chosen = [...earlier.slice(-wanted), ...now];
          return chosen.length > 0
            ? { runs: chosen }
            : {
                runs: chosen,
                note: "No finished run of this conversation has a trace yet; this may be its first run.",
              };
        }),
      }),
    );
    const toolkit = yield* SessionTraceTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
  }),
});
