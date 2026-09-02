import { type CommandInput, define, parseModelRef } from "@magentic/plugin";
import { Effect, Option } from "effect";

const NAME = "context";
/** The runner's estimate rule, named here so the readout can say so. */
const CHARS_PER_TOKEN = 4;

const count = (n: number): string => n.toLocaleString("en-US");

/** `$0.0123` under a cent, `$1.23` otherwise. */
const formatCost = (dollars: number): string =>
  dollars > 0 && dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;

const percent = (part: number, whole: number): string => {
  const share = (part / whole) * 100;
  return `${share < 1 ? "<1" : Math.round(share)}%`;
};

/** Indented label and count columns, `≈` because the counts are estimates. */
const table = (rows: ReadonlyArray<readonly [string, number]>): ReadonlyArray<string> => {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, n]) => `  ${label.padEnd(width)}  ≈ ${count(n)}`);
};

/** `(cache read 1,200, reasoning 40)`, leaving out what the provider did not report. */
const breakdown = (parts: ReadonlyArray<readonly [string, number | undefined]>): string => {
  const known = parts.flatMap(([label, n]) => (n === undefined ? [] : [`${label} ${count(n)}`]));
  return known.length === 0 ? "" : `  (${known.join(", ")})`;
};

/**
 * `/context`: what the chat's context holds, in tokens. The latest model call
 * is the whole conversation as the provider counted it, with the cache and
 * reasoning split when it reported one, then the running totals.
 */
export const contextCommandPlugin = define({
  id: "context-command",
  description: "The /context command: what the chat's context holds, in tokens.",
  setup: Effect.fn("contextCommandPlugin.setup")(function* (ctx) {
    /** The model's context window from its provider's catalog; 0 when unknown. */
    const windowOf = Effect.fn("context.windowOf")(function* (ref: string) {
      const parsed = parseModelRef(ref);
      for (const provider of yield* ctx.model.providers) {
        if (provider.id !== parsed.provider) {
          continue;
        }
        const id = Option.getOrElse(parsed.model, () => provider.defaultModel);
        return (yield* provider.models).find((m) => m.id === id)?.context ?? 0;
      }
      return 0;
    });

    const run = Effect.fn("context.run")(function* ({ ui, session }: CommandInput) {
      const model = yield* session.model;
      const usage = yield* session.usage;
      const reasoning = yield* session.reasoning;
      const lines: Array<string> = [
        Option.match(model, {
          onNone: () => "Model: none chosen",
          onSome: (ref) =>
            `Model: ${ref}${Option.match(reasoning, {
              onNone: () => "",
              onSome: (level) => ` · thinking ${level}`,
            })}`,
        }),
      ];
      if (Option.isNone(usage)) {
        lines.push("Context: empty until the first reply");
      } else {
        const { latest, calls, totalInputTokens, totalOutputTokens, totalCost } = usage.value;
        const window = Option.isSome(model) ? yield* windowOf(model.value) : 0;
        const held = latest.inputTokens + latest.outputTokens;
        const share = window > 0 ? ` of ${count(window)} (${percent(held, window)})` : "";
        const estimate = latest.breakdown;
        const tools = `tools (${estimate.toolCount})`;
        lines.push(
          `Context: ${count(held)} tokens${share}`,
          `  input   ${count(latest.inputTokens)}${breakdown([
            ["cache read", latest.cacheReadTokens],
            ["cache write", latest.cacheWriteTokens],
          ])}`,
          `  output  ${count(latest.outputTokens)}${breakdown([["reasoning", latest.reasoningTokens]])}`,
          `Held, estimated at ${CHARS_PER_TOKEN} characters a token (${estimate.messages} messages):`,
          ...table([
            ["system prompt", estimate.system],
            [tools, estimate.tools],
            ["user", estimate.user],
            ["assistant", estimate.assistant],
            ["tool calls", estimate.toolCalls],
          ]),
          `Session: ${calls} model ${calls === 1 ? "call" : "calls"} · ${count(totalInputTokens)} input · ${count(totalOutputTokens)} output${
            totalCost === undefined ? "" : ` · ${formatCost(totalCost)}`
          }`,
        );
      }
      yield* ui.notify(lines.join("\n"));
    });

    yield* ctx.command.register({
      name: NAME,
      description: "Show what the context holds, in tokens",
      run,
    });
  }),
});
