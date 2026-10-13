import { type CatalogModel, ModelInfo, reasoningBudget, reasoningLevelsOf } from "@magentic/plugin";
import { Context, Effect, Option, Schema } from "effect";
import * as Clients from "./Clients.ts";

/** The protocols Effect has clients for, and this module knows how to ask to think. */
export type Protocol = "anthropic" | "openai-responses" | "openai-compat";

const OpenAiEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Whether the OpenAI clients can send `level`; they check it against this list. */
export const isOpenAiEffort = Schema.is(OpenAiEffort);
/**
 * What the Messages API takes as `output_config.effort`. The client's config
 * type in rc.112 stops at `high`, but it copies the value into the request
 * as it is, and the catalog lists `xhigh` and `max` for the models that
 * take them.
 */
const AnthropicEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
const isAnthropicEffort = Schema.is(AnthropicEffort);
type ClientEffort = "low" | "medium" | "high";

/**
 * Whether a Claude model that takes an effort also needs to be asked for
 * adaptive thinking. Opus 4.6 through 4.8 and Sonnet 4.6 run without
 * thinking when the request leaves `thinking` out, whatever the effort, so an
 * effort alone only shaped how much they wrote; the 5-series and Fable think
 * by default and take `adaptive` as the same thing. Opus 4.5 takes an effort
 * but predates adaptive thinking, and its levels stop at `high`: `max`
 * arrived with adaptive thinking, in 4.6, which is what tells them apart. Other
 * vendors behind Anthropic's protocol, GLM on Z.AI, list efforts too but have
 * not said they take `adaptive`, so only Claude is asked.
 */
const takesAdaptive = (model: CatalogModel, efforts: ReadonlyArray<string | null>): boolean =>
  (model.family ?? model.id).startsWith("claude") &&
  efforts.some((effort) => effort === "xhigh" || effort === "max");

/**
 * The request configuration that makes a catalog model think at `level`,
 * as a context the runner provides around the call: OpenAI's reasoning
 * effort, Anthropic's effort when the model takes one (with adaptive
 * thinking, on the Claude models that take it) and a thinking budget
 * otherwise. None when the level is not one the model lists. The clients
 * are loaded when first asked, as the models are.
 */
export const reasoningContext = (
  protocol: Protocol,
  model: CatalogModel,
  level: string,
): Effect.Effect<Option.Option<Context.Context<never>>> => {
  if (!reasoningLevelsOf(model).includes(level)) {
    return Effect.succeedNone;
  }
  switch (protocol) {
    // Chat completions takes the effort as a plain field, and the config is
    // spread into the request, so a provider that does not know it ignores it.
    case "openai-compat":
      return isOpenAiEffort(level)
        ? Effect.map(Clients.openaiCompat, ({ OpenAiLanguageModel }) =>
            Option.some(Context.make(OpenAiLanguageModel.Config, { reasoning_effort: level })),
          )
        : Effect.succeedNone;
    case "openai-responses":
      return isOpenAiEffort(level)
        ? Effect.map(Clients.openai, ({ OpenAiLanguageModel }) =>
            Option.some(
              Context.make(OpenAiLanguageModel.Config, {
                reasoning: { effort: level, summary: "auto" },
              }),
            ),
          )
        : Effect.succeedNone;
    case "anthropic": {
      const effort = (model.reasoning_options ?? []).find((o) => o.type === "effort");
      if (effort !== undefined) {
        if (!isAnthropicEffort(level)) {
          return Effect.succeedNone;
        }
        // SAFETY: the level is one of AnthropicEffort, which the API accepts; the client sends it unchecked and only its config type lags behind.
        const output_config = { effort: level as ClientEffort };
        return Effect.map(Clients.anthropic, ({ AnthropicLanguageModel }) =>
          Option.some(
            Context.make(
              AnthropicLanguageModel.Config,
              takesAdaptive(model, effort.values ?? [])
                ? { thinking: { type: "adaptive" }, output_config }
                : { output_config },
            ),
          ),
        );
      }
      const info = ModelInfo.fromCatalog(model);
      const minimum =
        (model.reasoning_options ?? []).find((o) => o.type === "budget_tokens")?.min ?? 0;
      const budget = reasoningBudget(info, level, minimum);
      if (Option.isNone(budget)) {
        return Effect.succeedNone;
      }
      // The budget must fit under max_tokens, which the client sets from its own table otherwise.
      return Effect.map(Clients.anthropic, ({ AnthropicLanguageModel }) =>
        Option.some(
          Context.make(AnthropicLanguageModel.Config, {
            thinking: { type: "enabled", budget_tokens: budget.value },
            max_tokens: info.output,
          }),
        ),
      );
    }
  }
};
