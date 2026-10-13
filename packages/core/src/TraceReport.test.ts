import { assert, describe, it } from "@effect/vitest";
import { TRACE_CONVERSATION, TRACE_KIND, TRACE_RUN, TraceSpan } from "@magentic/protocol";
import { Schema } from "effect";
import { describeRunTrace, summarizeTrace, toChromeTrace, toOtlpJson } from "./TraceReport.ts";

const S = 1_000_000;

const span = (
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  start: number,
  end: number,
  attributes: Record<string, Schema.Json> = {},
  failed?: string,
) =>
  new TraceSpan({
    traceId,
    spanId,
    parentSpanId,
    name,
    start,
    end,
    status: failed === undefined ? "ok" : "error",
    error: failed,
    attributes,
  });

const tool = (name: string, extra: Record<string, Schema.Json> = {}) => ({
  [TRACE_KIND]: "tool",
  [TRACE_RUN]: "run-1",
  "gen_ai.tool.name": name,
  ...extra,
});

/**
 * One finished 10s run: a first model call (1s to 7s) that ran two shell
 * calls side by side (2s to 5s and 3s to 6s, one failing) and a refused
 * read_file, then a second model call (7.5s to 9.5s) that retried twice.
 */
const finished = [
  span("t1", "root", undefined, "invoke_agent assistant", 0, 10 * S, {
    [TRACE_KIND]: "run",
    [TRACE_RUN]: "run-1",
    [TRACE_CONVERSATION]: "c1",
    "gen_ai.agent.name": "assistant",
    "magentic.run.outcome": "stop",
  }),
  span("t1", "m1", "root", "chat gpt-5", 1 * S, 7 * S, {
    [TRACE_KIND]: "model",
    [TRACE_RUN]: "run-1",
    "gen_ai.request.model": "gpt-5",
    "magentic.first_output_ms": 850,
    "gen_ai.usage.input_tokens": 12000,
    "gen_ai.usage.output_tokens": 300,
    "magentic.usage.cache_read_tokens": 9000,
    "magentic.cost_usd": 0.02,
    "gen_ai.response.finish_reasons": ["tool-calls"],
  }),
  span("t1", "stream", "m1", "Chat.streamText", 1 * S, 7 * S),
  span("t1", "sh1", "stream", "execute_tool shell", 2 * S, 5 * S, tool("shell")),
  span(
    "t1",
    "sh2",
    "stream",
    "execute_tool shell",
    3 * S,
    6 * S,
    tool("shell", { "magentic.tool.failed": true, "magentic.tool.error": "exit 1" }),
  ),
  span(
    "t1",
    "rf",
    "stream",
    "execute_tool read_file",
    6.1 * S,
    6.2 * S,
    tool("read_file", { "magentic.tool.refused": "policy" }),
  ),
  span("t1", "m2", "root", "chat model", 7.5 * S, 9.5 * S, {
    [TRACE_KIND]: "model",
    [TRACE_RUN]: "run-1",
    "magentic.retries": 2,
    "magentic.cost_usd": 0.01,
  }),
  span("t1", "save", "root", "ConversationStore.append", 9.6 * S, 9.7 * S, {}, "disk full"),
];

/** A wake-up that found nothing to do. */
const idle = [
  span("t2", "idle", undefined, "invoke_agent assistant", 12 * S, 12.1 * S, {
    [TRACE_KIND]: "run",
    [TRACE_RUN]: "run-2",
    "magentic.run.outcome": "idle",
  }),
];

/** A run still going: its model call has ended, its own span has not. */
const running = [
  span("t3", "m3", "live", "chat gpt-5", 20 * S, 21 * S, {
    [TRACE_KIND]: "model",
    [TRACE_RUN]: "run-3",
  }),
];

const all = [...running, ...idle, ...finished];

const model = (spanId: string, start: number, end: number, extra: Record<string, Schema.Json>) =>
  span("t4", spanId, "root4", "chat gpt-5", start, end, {
    [TRACE_KIND]: "model",
    [TRACE_RUN]: "run-4",
    ...extra,
  });

const failing = (spanId: string, start: number) =>
  span("t4", spanId, "c4", "execute_tool shell", start, start + S, {
    [TRACE_KIND]: "tool",
    [TRACE_RUN]: "run-4",
    "gen_ai.tool.name": "shell",
    "magentic.tool.failed": true,
    "magentic.tool.error": "permission denied",
  });

/**
 * A 60s run that went wrong in every way a finding names: 15s compacting,
 * the cache lost on the third call, which also waited 18s to start and ran
 * out of output tokens, shell failing all three times, and the step limit.
 */
const troubled = [
  span("t4", "root4", undefined, "invoke_agent assistant", 30 * S, 90 * S, {
    [TRACE_KIND]: "run",
    [TRACE_RUN]: "run-4",
    "magentic.run.outcome": "step-limit",
  }),
  span("t4", "compact", "root4", "Runner.compact", 30 * S, 45 * S),
  model("c1", 45 * S, 50 * S, {
    "gen_ai.usage.input_tokens": 10000,
    "magentic.usage.cache_read_tokens": 9000,
    "magentic.first_output_ms": 1000,
  }),
  model("c2", 50 * S, 55 * S, {
    "gen_ai.usage.input_tokens": 12000,
    "magentic.usage.cache_read_tokens": 11000,
    "magentic.first_output_ms": 1200,
  }),
  model("c3", 55 * S, 75 * S, {
    "gen_ai.usage.input_tokens": 14000,
    "magentic.usage.cache_read_tokens": 700,
    "magentic.first_output_ms": 18000,
    "gen_ai.response.finish_reasons": ["length"],
  }),
  model("c4", 75 * S, 80 * S, {
    "gen_ai.usage.input_tokens": 15000,
    "magentic.usage.cache_read_tokens": 14000,
    "magentic.first_output_ms": 1400,
  }),
  failing("f1", 76 * S),
  failing("f2", 77 * S),
  failing("f3", 78 * S),
];

/** Two calls after the first, neither read from the cache. */
const uncached = [
  span("t5", "root5", undefined, "invoke_agent assistant", 100 * S, 106 * S, {
    [TRACE_KIND]: "run",
    [TRACE_RUN]: "run-5",
    "magentic.run.outcome": "stop",
  }),
  ...[0, 1, 2].map((n) =>
    span("t5", `u${n}`, "root5", "chat gpt-5", (100 + 2 * n) * S, (102 + 2 * n) * S, {
      [TRACE_KIND]: "model",
      [TRACE_RUN]: "run-5",
      "gen_ai.usage.input_tokens": 5000,
      "magentic.usage.cache_read_tokens": 0,
    }),
  ),
];

const summaries = () => {
  const runs = summarizeTrace(all);
  const [first, second] = runs;
  if (first === undefined || second === undefined) {
    throw new Error(`expected two runs, got ${runs.length}`);
  }
  return { runs, first, second };
};

describe("summarizeTrace", () => {
  it("gives each run oldest first, and leaves out a wake-up that did nothing", () => {
    const { runs, first, second } = summaries();
    assert.deepStrictEqual(
      runs.map((run) => run.runId),
      ["run-1", "run-3"],
    );
    assert.isFalse(first.inFlight);
    assert.strictEqual(first.agent, "assistant");
    assert.strictEqual(first.outcome, "stop");
    assert.isTrue(second.inFlight);
    assert.strictEqual(second.startedAt, "1970-01-01T00:00:20.000Z");
  });

  it("splits the run's time into model, tools counted once, and the rest", () => {
    const { first } = summaries();
    assert.strictEqual(first.durationMs, 10_000);
    // Tools: 2s to 6s side by side, plus the refused 0.1s.
    assert.strictEqual(first.toolMs, 4_100);
    // 6s less 4.1s of tools, and 2s.
    assert.strictEqual(first.modelMs, 3_900);
    assert.strictEqual(first.otherMs, 2_000);
    assert.closeTo(first.costUsd ?? 0, 0.03, 1e-9);
  });

  it("reports each model call with its tools, tokens, and retries", () => {
    const [call1, call2] = summaries().first.modelCalls;
    assert.deepStrictEqual(call1, {
      call: 1,
      model: "gpt-5",
      durationMs: 6_000,
      toolMs: 4_100,
      firstOutputMs: 850,
      inputTokens: 12000,
      outputTokens: 300,
      cacheReadTokens: 9000,
      costUsd: 0.02,
      finishReason: "tool-calls",
    });
    assert.deepStrictEqual(call2, {
      call: 2,
      durationMs: 2_000,
      toolMs: 0,
      costUsd: 0.01,
      retries: 2,
    });
  });

  it("counts each tool's calls, failures, and refusals", () => {
    assert.deepStrictEqual(summaries().first.tools, [
      {
        tool: "shell",
        calls: 2,
        totalMs: 6_000,
        maxMs: 3_000,
        failures: 1,
        refusals: 0,
        lastError: "exit 1",
      },
      {
        tool: "read_file",
        calls: 1,
        totalMs: 100,
        maxMs: 100,
        failures: 0,
        refusals: 1,
        refusedFor: "policy",
      },
    ]);
  });

  it("lists the errors and where the time went once children are taken out", () => {
    const { first } = summaries();
    assert.deepStrictEqual(first.errors, [
      { name: "ConversationStore.append", error: "disk full" },
    ]);
    const shell = first.slowest.find((entry) => entry.name === "execute_tool shell");
    assert.deepStrictEqual(shell, { name: "execute_tool shell", calls: 2, selfMs: 6_000 });
    // The stream spans the whole call, but the tools covered 4.1s of it.
    const stream = first.slowest.find((entry) => entry.name === "Chat.streamText");
    assert.strictEqual(stream?.selfMs, 1_900);
  });

  it("finds only what stands out in an ordinary run", () => {
    const { first, second } = summaries();
    assert.deepStrictEqual(first.findings, [
      "read_file was refused once: policy",
      "the model was retried 2 times after provider errors, on #2; the waits count as model time",
    ]);
    assert.deepStrictEqual(second.findings, []);
  });

  it("names each kind of trouble, weightiest first", () => {
    const [run] = summarizeTrace(troubled);
    assert.deepStrictEqual(run?.findings, [
      "the run stopped at its step limit after 4 model calls",
      "shell failed 3 of its 3 calls; the latest said: permission denied",
      "call #3 read 5% of its 14,000 input tokens from the prompt cache, down from 92% on the call before: something early in the prompt changed, so most of it was billed at the full rate",
      "call #3 waited 18.0s for its first output, against 1.3s typical in this run",
      "call #3 stopped at the output token limit, its answer cut short",
      "25.0s went to neither the model nor tools, Runner.compact the most (15.0s)",
    ]);
  });

  it("says when no call after the first read from the cache", () => {
    const [run] = summarizeTrace(uncached);
    assert.deepStrictEqual(run?.findings, [
      "none of the 2 calls after the first read from the prompt cache, so each paid the full input rate",
    ]);
  });

  it("is JSON through and through, so a tool can return it", () => {
    const { runs } = summaries();
    assert.doesNotThrow(() => Schema.decodeSync(Schema.Json)(runs));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(runs)), runs);
  });
});

describe("describeRunTrace", () => {
  it("names the calls, retries, tool trouble, and errors", () => {
    const text = describeRunTrace(summaries().first);
    assert.include(text, "Run run-1 · assistant · 10.0s · stop · $0.03");
    assert.include(text, "model 3.9s over 2 calls · tools 4.1s · other 2.0s");
    assert.include(text, "! read_file was refused once: policy");
    assert.include(text, "#1 gpt-5 · 6.0s · first output 850ms · 12,000 in, 75% cached");
    assert.include(text, "#2 model · 2.0s · 2 retried");
    assert.include(text, "shell ×2 6.0s (max 3.0s, 1 failed)");
    assert.include(text, "read_file ×1 100ms (max 100ms, 1 refused)");
    assert.include(text, "error in ConversationStore.append: disk full");
  });
});

describe("toChromeTrace", () => {
  const { traceEvents } = toChromeTrace(all);
  const spans = traceEvents.filter((event) => event.ph === "X");

  it("puts each run in a process of its own, named for it", () => {
    const names = traceEvents
      .filter((event) => event.name === "process_name")
      .map((event) => event.args["name"]);
    assert.deepStrictEqual(names, ["run run-1 assistant", "run run-3"]);
    assert.strictEqual(spans.length, finished.length + running.length);
  });

  it("nests every track properly, and runs side-by-side calls on tracks of their own", () => {
    const byTrack = new Map<string, Array<(typeof spans)[number]>>();
    for (const event of spans) {
      const key = `${event.pid}/${event.tid}`;
      byTrack.set(key, [...(byTrack.get(key) ?? []), event]);
    }
    for (const [key, events] of byTrack) {
      const stack: Array<number> = [];
      for (const event of events.toSorted((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
        const start = event.ts ?? 0;
        while (stack.length > 0 && (stack.at(-1) ?? 0) <= start) {
          stack.pop();
        }
        const end = start + (event.dur ?? 0);
        const top = stack.at(-1);
        assert.isTrue(top === undefined || end <= top, `${event.name} overlaps on track ${key}`);
        stack.push(end);
      }
    }
    const shells = spans.filter((event) => event.name === "execute_tool shell");
    assert.notStrictEqual(shells[0]?.tid, shells[1]?.tid);
  });
});

describe("toOtlpJson", () => {
  const [resource] = toOtlpJson(finished, "magentic-gateway").resourceSpans;
  const exported = resource?.scopeSpans[0]?.spans ?? [];
  const byName = (name: string) => exported.find((item) => item.name === name);

  it("names the service and keeps every span", () => {
    assert.deepStrictEqual(resource?.resource.attributes, [
      { key: "service.name", value: { stringValue: "magentic-gateway" } },
    ]);
    assert.strictEqual(exported.length, finished.length);
  });

  it("gives times in nanoseconds and a parent only where there is one", () => {
    const root = byName("invoke_agent assistant");
    const call = byName("chat gpt-5");
    assert.strictEqual(call?.startTimeUnixNano, "1000000000");
    assert.strictEqual(call?.endTimeUnixNano, "7000000000");
    assert.isFalse(root !== undefined && "parentSpanId" in root);
    assert.isTrue(call !== undefined && "parentSpanId" in call && call.parentSpanId === "root");
  });

  it("types each attribute and carries a failure's message", () => {
    const attributes = byName("chat gpt-5")?.attributes ?? [];
    const value = (key: string) => attributes.find((item) => item.key === key)?.value;
    assert.deepStrictEqual(value("gen_ai.usage.input_tokens"), { intValue: 12000 });
    assert.deepStrictEqual(value("magentic.cost_usd"), { doubleValue: 0.02 });
    assert.deepStrictEqual(value("gen_ai.request.model"), { stringValue: "gpt-5" });
    assert.deepStrictEqual(value("gen_ai.response.finish_reasons"), {
      arrayValue: { values: [{ stringValue: "tool-calls" }] },
    });
    assert.deepStrictEqual(byName("ConversationStore.append")?.status, {
      code: 2,
      message: "disk full",
    });
    assert.deepStrictEqual(byName("chat gpt-5")?.status, { code: 1 });
  });
});
