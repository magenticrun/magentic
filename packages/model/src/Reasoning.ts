import { type CatalogModel, ModelInfo, reasoningBudget, reasoningLevelsOf } from "@magentic/plugin";
import { Context, Effect, Option, Schema } from "effect";
import * as Clients from "./Clients.ts";

/** The protocols Effect has clients for, and this module knows how to ask to think. */
export type Protocol = "anthropic" | "openai-responses" | "openai-compat";

const OpenAiEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isOpenAiEffort = Schema.is(OpenAiEffort);
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
 * The request configuration that makes a catalog model think at `level`,
 * as a context the runner provides around the call: OpenAI's reasoning
 * effort, Anthropic's effort when the model takes one and a thinking budget
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
      const takesEffort = (model.reasoning_options ?? []).some((o) => o.type === "effort");
      if (takesEffort) {
        return isAnthropicEffort(level)
          ? Effect.map(Clients.anthropic, ({ AnthropicLanguageModel }) =>
              Option.some(
                Context.make(AnthropicLanguageModel.Config, {
                  // SAFETY: the level is one of AnthropicEffort, which the API accepts; the client sends it unchecked and only its config type lags behind.
                  output_config: { effort: level as ClientEffort },
                }),
              ),
            )
          : Effect.succeedNone;
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
