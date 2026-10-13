import { TRACE_KIND, TRACE_RUN, type TraceSpan } from "@magentic/protocol";
import { DateTime, Predicate, Schema, type Types } from "effect";
import { STEP_LIMIT_REASON } from "./Runner.ts";

/**
 * What a conversation's trace says, in the shapes people and agents read it
 * in: a summary of each run, OTLP JSON for a collector or Jaeger, and
 * Chrome's trace format for Perfetto or speedscope. Pure: every function
 * here works from the spans alone.
 */

/** One model call: the request, its retries, and the tools it ran before it ended. */
export const ModelCallTrace = Schema.Struct({
  /** Its place in the run, from 1, as findings name it. */
  call: Schema.Finite,
  model: Schema.optionalKey(Schema.String),
  durationMs: Schema.Finite,
  /** Of the duration, how much the tools this call asked for took. */
  toolMs: Schema.Finite,
  /** From the request until the first part of the answer arrived, retries included. */
  firstOutputMs: Schema.optionalKey(Schema.Finite),
  inputTokens: Schema.optionalKey(Schema.Finite),
  outputTokens: Schema.optionalKey(Schema.Finite),
  cacheReadTokens: Schema.optionalKey(Schema.Finite),
  cacheWriteTokens: Schema.optionalKey(Schema.Finite),
  reasoningTokens: Schema.optionalKey(Schema.Finite),
  costUsd: Schema.optionalKey(Schema.Finite),
  finishReason: Schema.optionalKey(Schema.String),
  retries: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String),
});
export type ModelCallTrace = typeof ModelCallTrace.Type;

/** One tool across the run's calls of it. */
export const ToolTrace = Schema.Struct({
  tool: Schema.String,
  calls: Schema.Finite,
  totalMs: Schema.Finite,
  maxMs: Schema.Finite,
  failures: Schema.Finite,
  /** Calls policy or a hook turned away before the tool ran. */
  refusals: Schema.Finite,
  /** What the latest failed call said, shortened. */
  lastError: Schema.optionalKey(Schema.String),
  /** Why the latest refused call was turned away. */
  refusedFor: Schema.optionalKey(Schema.String),
});
export type ToolTrace = typeof ToolTrace.Type;

/** Where a run's time went once what ran inside each span is taken away. */
export const SelfTime = Schema.Struct({
  name: Schema.String,
  calls: Schema.Finite,
  selfMs: Schema.Finite,
});

/** A span that ended in error, and what it said. */
export const TraceError = Schema.Struct({ name: Schema.String, error: Schema.String });

/** One run of the conversation, as its spans tell it. */
export const RunTrace = Schema.Struct({
  runId: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  durationMs: Schema.Finite,
  /** Still running: only what finished so far is here. */
  inFlight: Schema.Boolean,
  /** Why it ended: the model's finish reason, `step-limit`, `failed`, or `interrupted`. */
  outcome: Schema.optionalKey(Schema.String),
  /**
   * What stood out, in a sentence each: the prompt cache missing, a slow
   * first answer, retries, a tool failing again and again, time lost outside
   * the model and tools. Empty when nothing did.
   */
  findings: Schema.Array(Schema.String),
  /** Waiting on the model, retries and the waits between them included, tools excluded. */
  modelMs: Schema.Finite,
  /** Tools running, overlapping calls counted once. */
  toolMs: Schema.Finite,
  /** Neither: loading and saving the conversation, compaction. */
  otherMs: Schema.Finite,
  costUsd: Schema.optionalKey(Schema.Finite),
  modelCalls: Schema.Array(ModelCallTrace),
  tools: Schema.Array(ToolTrace),
  slowest: Schema.Array(SelfTime),
  errors: Schema.Array(TraceError),
});
export type RunTrace = typeof RunTrace.Type;

/** The span kinds magentic marks its own spans with. */
const RUN = "run";
const MODEL = "model";
const TOOL = "tool";

/** How many of the heaviest span names a summary lists. */
const SLOWEST = 8;
/** How many errors a summary lists; the rest are the same story. */
const ERRORS = 10;
/** How many model calls a summary lists, the latest kept. */
const MODEL_CALLS = 40;
/** How many findings a summary lists, the weightiest first. */
const FINDINGS = 8;
/** How much of an error message a summary quotes. */
const QUOTED = 300;
/** Input shorter than this is too short for providers to cache, so a miss on it says nothing. */
const CACHEABLE_TOKENS = 2_048;
/** A wait for the first output this long is worth saying however the rest of the run went. */
const SLOW_FIRST_MS = 15_000;
/** How many times the run's median wait a call's may be before it is called slow. */
const SLOW_FACTOR = 3;
/** How long a wait must be before it is called slow on the median alone. */
const SLOWER_MS = 5_000;

const text = (span: TraceSpan, key: string): string | undefined => {
  const value = span.attributes[key];
  return Predicate.isString(value) ? value : undefined;
};

const count = (span: TraceSpan, key: string): number | undefined => {
  const value = span.attributes[key];
  return Predicate.isNumber(value) ? value : undefined;
};

const kindOf = (span: TraceSpan): string | undefined => text(span, TRACE_KIND);

const ms = (micros: number): number => Math.round(micros / 100) / 10;

const seconds = (millis: number): string =>
  millis < 1000 ? `${Math.round(millis)}ms` : `${(millis / 1000).toFixed(1)}s`;

const tokens = (n: number): string => n.toLocaleString("en-US");

const dollars = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

const quoted = (message: string): string =>
  message.length > QUOTED ? `${message.slice(0, QUOTED)}…` : message;

/** What share of a call's input came from the prompt cache, when the provider says. */
const cachedShare = (call: ModelCallTrace): number | undefined =>
  call.inputTokens === undefined || call.cacheReadTokens === undefined || call.inputTokens === 0
    ? undefined
    : call.cacheReadTokens / call.inputTokens;

const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** Where the time outside the model and tools went the most: a step of the run's own, and how long. */
interface Outside {
  readonly name: string;
  readonly ms: number;
}

/**
 * What stood out in a run, weightiest first, each a sentence a person or a
 * model can act on. Every finding has a floor under it, so an ordinary run
 * has none.
 */
const findingsOf = (
  run: Omit<RunTrace, "findings">,
  calls: ReadonlyArray<ModelCallTrace>,
  outside: Outside | undefined,
): Array<string> => {
  const findings: Array<string> = [];
  if (run.outcome === STEP_LIMIT_REASON) {
    findings.push(`the run stopped at its step limit after ${calls.length} model calls`);
  }
  for (const tool of run.tools) {
    if (tool.failures >= 2) {
      findings.push(
        `${tool.tool} failed ${tool.failures} of its ${tool.calls} calls${tool.lastError === undefined ? "" : `; the latest said: ${tool.lastError}`}`,
      );
    }
    if (tool.refusals > 0) {
      findings.push(
        `${tool.tool} was refused ${times(tool.refusals)}${tool.refusedFor === undefined ? "" : `: ${tool.refusedFor}`}`,
      );
    }
  }

  calls.forEach((call, index) => {
    const before = calls[index - 1];
    const share = cachedShare(call);
    const previous = before === undefined ? undefined : cachedShare(before);
    if (
      share !== undefined &&
      previous !== undefined &&
      (call.inputTokens ?? 0) >= CACHEABLE_TOKENS &&
      previous >= 0.5 &&
      share < previous / 2
    ) {
      findings.push(
        `call #${call.call} read ${percent(share)} of its ${tokens(call.inputTokens ?? 0)} input tokens from the prompt cache, down from ${percent(previous)} on the call before: something early in the prompt changed, so most of it was billed at the full rate`,
      );
    }
  });
  const later = calls
    .slice(1)
    .filter(
      (call) => (call.inputTokens ?? 0) >= CACHEABLE_TOKENS && call.cacheReadTokens !== undefined,
    );
  if (later.length >= 2 && later.every((call) => call.cacheReadTokens === 0)) {
    findings.push(
      `none of the ${later.length} calls after the first read from the prompt cache, so each paid the full input rate`,
    );
  }

  const waits = calls.flatMap((call) =>
    call.firstOutputMs === undefined ? [] : [{ call: call.call, ms: call.firstOutputMs }],
  );
  const typical = median(waits.map((wait) => wait.ms));
  const slowest = waits.toSorted((a, b) => b.ms - a.ms)[0];
  if (
    slowest !== undefined &&
    (slowest.ms >= SLOW_FIRST_MS ||
      (waits.length >= 3 && slowest.ms >= SLOWER_MS && slowest.ms >= SLOW_FACTOR * typical))
  ) {
    findings.push(
      `call #${slowest.call} waited ${seconds(slowest.ms)} for its first output${waits.length >= 3 ? `, against ${seconds(typical)} typical in this run` : ""}`,
    );
  }

  const retried = calls.filter((call) => (call.retries ?? 0) > 0);
  if (retried.length > 0) {
    const total = retried.reduce((sum, call) => sum + (call.retries ?? 0), 0);
    findings.push(
      `the model was retried ${times(total)} after provider errors, on ${retried.map((call) => `#${call.call}`).join(", ")}; the waits count as model time`,
    );
  }
  for (const call of calls) {
    if (call.finishReason === "length") {
      findings.push(`call #${call.call} stopped at the output token limit, its answer cut short`);
    }
    if (call.finishReason === "content-filter") {
      findings.push(`call #${call.call} was stopped by the provider's content filter`);
    }
  }

  const top = run.tools[0];
  if (top !== undefined && run.toolMs >= SLOWER_MS && run.toolMs >= run.durationMs / 2) {
    findings.push(
      `tools took ${percent(run.toolMs / run.durationMs)} of the run, ${top.tool} the most: ${seconds(top.totalMs)} over ${top.calls} ${top.calls === 1 ? "call" : "calls"}`,
    );
  }
  if (run.otherMs >= SLOWER_MS / 2 && run.otherMs >= run.durationMs / 4) {
    findings.push(
      `${seconds(run.otherMs)} went to neither the model nor tools${outside === undefined ? "" : `, ${outside.name} the most (${seconds(outside.ms)})`}`,
    );
  }
  return findings.slice(0, FINDINGS);
};

/** The total length of the intervals, overlaps counted once. */
const covered = (intervals: ReadonlyArray<readonly [number, number]>): number => {
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0])) {
    if (end <= reach) {
      continue;
    }
    total += end - Math.max(start, reach);
    reach = end;
  }
  return total;
};

/** A run: the spans of one trace, and the run's own span once it has ended. */
interface RunSpans {
  readonly traceId: string;
  readonly spans: ReadonlyArray<TraceSpan>;
  readonly root: TraceSpan | undefined;
}

/**
 * The spans by run, oldest first. Each run starts a trace of its own, so a
 * trace is a run; one whose own span has not ended is still running. A
 * wake-up that found nothing to say is no run at all and is left out.
 */
const runsOf = (spans: ReadonlyArray<TraceSpan>): ReadonlyArray<RunSpans> => {
  const byTrace = new Map<string, Array<TraceSpan>>();
  for (const span of spans) {
    const group = byTrace.get(span.traceId);
    if (group === undefined) {
      byTrace.set(span.traceId, [span]);
    } else {
      group.push(span);
    }
  }
  const runs: Array<RunSpans> = [];
  for (const [traceId, group] of byTrace) {
    const root = group.find((span) => kindOf(span) === RUN);
    // Spans from outside any run of ours, or a run trimmed away from the front of the file.
    const ours = group.some((span) => kindOf(span) !== undefined);
    if (!ours || (root !== undefined && text(root, "magentic.run.outcome") === "idle")) {
      continue;
    }
    runs.push({ traceId, spans: group, root });
  }
  const startOf = (run: RunSpans) => Math.min(...run.spans.map((span) => span.start));
  return runs.toSorted((a, b) => startOf(a) - startOf(b));
};

/** The run's id, from its own span or, while it runs, from any span under it. */
const runIdOf = (run: RunSpans): string =>
  (run.root === undefined ? undefined : text(run.root, TRACE_RUN)) ??
  run.spans.map((span) => text(span, TRACE_RUN)).find(Predicate.isNotUndefined) ??
  run.traceId;

/** Each span's parent, when the parent is among the spans. */
const parentsOf = (spans: ReadonlyArray<TraceSpan>) => {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  return (span: TraceSpan): TraceSpan | undefined =>
    span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
};

/** Each span's own time: its length less what its children covered of it. */
const selfTimes = (spans: ReadonlyArray<TraceSpan>): Map<TraceSpan, number> => {
  const parent = parentsOf(spans);
  const children = new Map<TraceSpan, Array<readonly [number, number]>>();
  for (const span of spans) {
    const up = parent(span);
    if (up !== undefined) {
      const clipped = [Math.max(span.start, up.start), Math.min(span.end, up.end)] as const;
      const list = children.get(up);
      if (list === undefined) {
        children.set(up, [clipped]);
      } else {
        list.push(clipped);
      }
    }
  }
  return new Map(
    spans.map((span) => [
      span,
      Math.max(0, span.end - span.start - covered(children.get(span) ?? [])),
    ]),
  );
};

/** One run's summary. */
const summarizeRun = (run: RunSpans): RunTrace => {
  const { spans, root } = run;
  const parent = parentsOf(spans);
  const start = root?.start ?? Math.min(...spans.map((span) => span.start));
  const end = root?.end ?? Math.max(...spans.map((span) => span.end));
  const models = spans
    .filter((span) => kindOf(span) === MODEL)
    .toSorted((a, b) => a.start - b.start);
  const tools = spans.filter((span) => kindOf(span) === TOOL).toSorted((a, b) => a.end - b.end);

  /** The model call a tool ran under, found by walking up. */
  const callOf = (span: TraceSpan): TraceSpan | undefined => {
    for (let up = parent(span); up !== undefined; up = parent(up)) {
      if (kindOf(up) === MODEL) {
        return up;
      }
    }
    return undefined;
  };
  const toolsByCall = new Map<TraceSpan, Array<readonly [number, number]>>();
  for (const tool of tools) {
    const call = callOf(tool);
    if (call !== undefined) {
      const list = toolsByCall.get(call);
      const interval = [tool.start, tool.end] as const;
      if (list === undefined) {
        toolsByCall.set(call, [interval]);
      } else {
        list.push(interval);
      }
    }
  }

  const modelCalls = models.map((span, index) => {
    const call: Types.Mutable<ModelCallTrace> = {
      call: index + 1,
      durationMs: ms(span.end - span.start),
      toolMs: ms(covered(toolsByCall.get(span) ?? [])),
    };
    const model = text(span, "gen_ai.request.model");
    const first = count(span, "magentic.first_output_ms");
    const input = count(span, "gen_ai.usage.input_tokens");
    const output = count(span, "gen_ai.usage.output_tokens");
    const cacheRead = count(span, "magentic.usage.cache_read_tokens");
    const cacheWrite = count(span, "magentic.usage.cache_write_tokens");
    const reasoning = count(span, "magentic.usage.reasoning_tokens");
    const cost = count(span, "magentic.cost_usd");
    const retries = count(span, "magentic.retries");
    const reasons = span.attributes["gen_ai.response.finish_reasons"];
    const reason = Array.isArray(reasons) ? reasons.find(Predicate.isString) : undefined;
    // Absent, not undefined: the summary goes to the model as JSON, which has no undefined.
    if (model !== undefined) call.model = model;
    if (first !== undefined) call.firstOutputMs = first;
    if (input !== undefined) call.inputTokens = input;
    if (output !== undefined) call.outputTokens = output;
    if (cacheRead !== undefined) call.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined) call.cacheWriteTokens = cacheWrite;
    if (reasoning !== undefined) call.reasoningTokens = reasoning;
    if (cost !== undefined) call.costUsd = cost;
    if (reason !== undefined) call.finishReason = reason;
    if (retries !== undefined) call.retries = retries;
    if (span.error !== undefined) call.error = span.error;
    return call;
  });

  const toolStats = new Map<string, Types.Mutable<ToolTrace>>();
  for (const span of tools) {
    const name = text(span, "gen_ai.tool.name") ?? span.name;
    const took = ms(span.end - span.start);
    const stat = toolStats.get(name) ?? {
      tool: name,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      failures: 0,
      refusals: 0,
    };
    stat.calls += 1;
    stat.totalMs = Math.round((stat.totalMs + took) * 10) / 10;
    stat.maxMs = Math.max(stat.maxMs, took);
    if (span.status === "error" || span.attributes["magentic.tool.failed"] === true) {
      stat.failures += 1;
      const said = text(span, "magentic.tool.error") ?? span.error;
      if (said !== undefined) stat.lastError = quoted(said);
    }
    const refusal = text(span, "magentic.tool.refused");
    if (refusal !== undefined) {
      stat.refusals += 1;
      stat.refusedFor = quoted(refusal);
    }
    toolStats.set(name, stat);
  }

  const self = selfTimes(spans);
  const heaviest = new Map<string, { calls: number; micros: number }>();
  for (const span of spans) {
    if (span === root) {
      continue;
    }
    const entry = heaviest.get(span.name) ?? { calls: 0, micros: 0 };
    entry.calls += 1;
    entry.micros += self.get(span) ?? 0;
    heaviest.set(span.name, entry);
  }
  const slowest = [...heaviest]
    .toSorted((a, b) => b[1].micros - a[1].micros)
    .slice(0, SLOWEST)
    .map(([name, entry]) => ({ name, calls: entry.calls, selfMs: ms(entry.micros) }));

  const errors = spans.flatMap((span) =>
    span.status === "error" && span.error !== undefined
      ? [{ name: span.name, error: span.error }]
      : [],
  );

  const toolMicros = covered(tools.map((span) => [span.start, span.end] as const));
  const modelMicros = models.reduce(
    (sum, span) => sum + span.end - span.start - covered(toolsByCall.get(span) ?? []),
    0,
  );
  // The run's own steps outside any model call, by name: loading, saving, compacting.
  const outsideByName = new Map<string, number>();
  for (const span of spans) {
    if (root !== undefined && parent(span) === root && kindOf(span) === undefined) {
      outsideByName.set(span.name, (outsideByName.get(span.name) ?? 0) + span.end - span.start);
    }
  }
  const outside = [...outsideByName]
    .toSorted((a, b) => b[1] - a[1])
    .map(([name, micros]) => ({ name, ms: ms(micros) }))[0];
  const costs = modelCalls.flatMap((call) => (call.costUsd === undefined ? [] : [call.costUsd]));
  const summary: Types.Mutable<RunTrace> = {
    runId: runIdOf(run),
    startedAt: DateTime.formatIso(DateTime.makeUnsafe(Math.floor(start / 1000))),
    durationMs: ms(end - start),
    inFlight: root === undefined,
    findings: [],
    modelMs: ms(modelMicros),
    toolMs: ms(toolMicros),
    otherMs: ms(Math.max(0, end - start - modelMicros - toolMicros)),
    modelCalls: modelCalls.slice(-MODEL_CALLS),
    tools: [...toolStats.values()].toSorted((a, b) => b.totalMs - a.totalMs),
    slowest,
    errors: errors.slice(0, ERRORS),
  };
  const agent = root === undefined ? undefined : text(root, "gen_ai.agent.name");
  const outcome =
    root === undefined
      ? undefined
      : root.status === "interrupted"
        ? "interrupted"
        : text(root, "magentic.run.outcome");
  if (agent !== undefined) summary.agent = agent;
  if (outcome !== undefined) summary.outcome = outcome;
  if (costs.length > 0) summary.costUsd = costs.reduce((a, b) => a + b, 0);
  summary.findings = findingsOf(summary, modelCalls, outside);
  return summary;
};

/** Every run's summary, oldest first. */
export const summarizeTrace = (spans: ReadonlyArray<TraceSpan>): ReadonlyArray<RunTrace> =>
  runsOf(spans).map(summarizeRun);

/** A run's summary as lines for a terminal. */
export const describeRunTrace = (run: RunTrace): string => {
  const head = [
    `Run ${run.runId.slice(0, 8)}`,
    run.agent,
    seconds(run.durationMs),
    run.inFlight ? "in flight" : run.outcome,
    run.costUsd === undefined ? undefined : dollars(run.costUsd),
  ].filter(Predicate.isNotUndefined);
  const lines = [
    head.join(" · "),
    `  model ${seconds(run.modelMs)} over ${run.modelCalls.length} ${run.modelCalls.length === 1 ? "call" : "calls"} · tools ${seconds(run.toolMs)} · other ${seconds(run.otherMs)}`,
    ...run.findings.map((finding) => `  ! ${finding}`),
  ];
  for (const call of run.modelCalls) {
    const share = cachedShare(call);
    const parts = [
      `  #${call.call} ${call.model ?? "model"}`,
      seconds(call.durationMs),
      call.firstOutputMs === undefined ? undefined : `first output ${seconds(call.firstOutputMs)}`,
      call.inputTokens === undefined
        ? undefined
        : `${tokens(call.inputTokens)} in${share === undefined ? "" : `, ${percent(share)} cached`}`,
      call.outputTokens === undefined ? undefined : `${tokens(call.outputTokens)} out`,
      call.toolMs > 0 ? `tools ${seconds(call.toolMs)}` : undefined,
      call.retries === undefined ? undefined : `${call.retries} retried`,
      call.error === undefined ? undefined : `failed: ${call.error}`,
    ].filter(Predicate.isNotUndefined);
    lines.push(parts.join(" · "));
  }
  if (run.tools.length > 0) {
    lines.push(
      `  tools: ${run.tools
        .map((tool) => {
          const notes = [
            tool.failures > 0 ? `${tool.failures} failed` : undefined,
            tool.refusals > 0 ? `${tool.refusals} refused` : undefined,
          ].filter(Predicate.isNotUndefined);
          const extra = notes.length > 0 ? `, ${notes.join(", ")}` : "";
          return `${tool.tool} ×${tool.calls} ${seconds(tool.totalMs)} (max ${seconds(tool.maxMs)}${extra})`;
        })
        .join(" · ")}`,
    );
  }
  if (run.slowest.length > 0) {
    lines.push(
      `  slowest: ${run.slowest
        .slice(0, 5)
        .map(
          (entry) =>
            `${entry.name} ${seconds(entry.selfMs)}${entry.calls > 1 ? ` ×${entry.calls}` : ""}`,
        )
        .join(" · ")}`,
    );
  }
  for (const error of run.errors.slice(0, 3)) {
    lines.push(`  error in ${error.name}: ${error.error}`);
  }
  return lines.join("\n");
};

/** An OTLP attribute value. */
interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: number;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  readonly arrayValue?: { readonly values: ReadonlyArray<OtlpValue> };
  readonly kvlistValue?: { readonly values: ReadonlyArray<OtlpKeyValue> };
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpValue;
}

const otlpValue = (value: Schema.Json): OtlpValue => {
  if (Predicate.isString(value)) {
    return { stringValue: value };
  }
  if (Predicate.isNumber(value)) {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (Predicate.isBoolean(value)) {
    return { boolValue: value };
  }
  if (value === null) {
    return {};
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(otlpValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value).map(([key, item]) => ({ key, value: otlpValue(item) })),
    },
  };
};

/** OTLP's status codes: unset, ok, error. */
const OTLP_STATUS = { ok: 1, error: 2, interrupted: 0 } as const;
/** OTLP's `SPAN_KIND_INTERNAL`: the store keeps no kind, and every span of a run is in-process. */
const OTLP_INTERNAL = 1;

/**
 * The spans as an OTLP/JSON trace export, as a collector's `/v1/traces`
 * accepts it and Jaeger's upload reads it.
 */
export const toOtlpJson = (spans: ReadonlyArray<TraceSpan>, serviceName: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [
        {
          scope: { name: "magentic" },
          spans: spans.map((span) => {
            const otlp = {
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              kind: OTLP_INTERNAL,
              startTimeUnixNano: `${Math.round(span.start)}000`,
              endTimeUnixNano: `${Math.round(span.end)}000`,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: otlpValue(value),
              })),
              status:
                span.error === undefined
                  ? { code: OTLP_STATUS[span.status] }
                  : { code: OTLP_STATUS[span.status], message: span.error },
            };
            return span.parentSpanId === undefined
              ? otlp
              : { ...otlp, parentSpanId: span.parentSpanId };
          }),
        },
      ],
    },
  ],
});

/**
 * Tracks for a run's spans so each track nests properly, as Perfetto and
 * speedscope need: a span shares a track with the span on top of it only
 * when that one is its ancestor and outlasts it. Parallel tool calls get a
 * track each.
 */
const tracksOf = (spans: ReadonlyArray<TraceSpan>): Map<TraceSpan, number> => {
  const parent = parentsOf(spans);
  const isAncestor = (candidate: TraceSpan, span: TraceSpan): boolean => {
    for (let up = parent(span); up !== undefined; up = parent(up)) {
      if (up === candidate) {
        return true;
      }
    }
    return false;
  };
  const stacks: Array<Array<TraceSpan>> = [];
  const track = new Map<TraceSpan, number>();
  const ordered = spans.toSorted((a, b) => a.start - b.start || b.end - a.end);
  for (const span of ordered) {
    const fits = (index: number): boolean => {
      const stack = stacks[index] ?? [];
      while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= span.start) {
        stack.pop();
      }
      const top = stack.at(-1);
      return top === undefined || (top.end >= span.end && isAncestor(top, span));
    };
    const up = parent(span);
    const preferred = up === undefined ? undefined : track.get(up);
    let chosen = preferred !== undefined && fits(preferred) ? preferred : undefined;
    for (let index = 0; chosen === undefined && index < stacks.length; index++) {
      if (fits(index)) {
        chosen = index;
      }
    }
    if (chosen === undefined) {
      chosen = stacks.length;
      stacks.push([]);
    }
    stacks[chosen]?.push(span);
    track.set(span, chosen);
  }
  return track;
};

/** One event of Chrome's trace format: `X` a span, `M` a name for a process. */
interface ChromeEvent {
  readonly ph: "X" | "M";
  readonly name: string;
  readonly cat?: string;
  readonly pid: number;
  readonly tid: number;
  readonly ts?: number;
  readonly dur?: number;
  readonly args: Readonly<Record<string, Schema.Json | undefined>>;
}

/**
 * The spans in Chrome's trace event format, which Perfetto
 * (ui.perfetto.dev) and speedscope open as a flame chart: a process per run,
 * a thread per track.
 */
export const toChromeTrace = (spans: ReadonlyArray<TraceSpan>) => {
  const events: Array<ChromeEvent> = [];
  runsOf(spans).forEach((run, index) => {
    const pid = index + 1;
    const agent = run.root === undefined ? undefined : text(run.root, "gen_ai.agent.name");
    const runId = runIdOf(run);
    events.push({
      ph: "M",
      name: "process_name",
      pid,
      tid: 0,
      args: { name: `run ${runId.slice(0, 8)}${agent === undefined ? "" : ` ${agent}`}` },
    });
    events.push({ ph: "M", name: "process_sort_index", pid, tid: 0, args: { sort_index: pid } });
    const tracks = tracksOf(run.spans);
    for (const span of run.spans) {
      const args = { ...span.attributes, status: span.status, error: span.error };
      events.push({
        ph: "X",
        name: span.name,
        cat: kindOf(span) ?? "effect",
        pid,
        tid: tracks.get(span) ?? 0,
        ts: span.start,
        dur: Math.max(0, span.end - span.start),
        args,
      });
    }
  });
  return { traceEvents: events, displayTimeUnit: "ms" };
};
