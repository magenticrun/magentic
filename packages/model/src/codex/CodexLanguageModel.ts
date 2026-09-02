import { Effect, Layer } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import * as Clients from "../Clients.ts";
import type { CodexAuth } from "./CodexAuth.ts";
import { layerClient } from "./CodexClient.ts";

/** The slug the Codex CLI defaults to at the time of writing; see the research doc. */
export const DEFAULT_MODEL = "gpt-5.5";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CodexModelOptions {
  readonly model?: string | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

/**
 * A LanguageModel backed by a ChatGPT subscription. The request shape follows
 * what the Codex CLI hard-codes: never stored, reasoning replayed via
 * encrypted content, no token or temperature caps.
 */
export const layer = (
  options: CodexModelOptions = {},
): Layer.Layer<LanguageModel.LanguageModel, never, CodexAuth | HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.map(Clients.openai, ({ OpenAiLanguageModel }) =>
      OpenAiLanguageModel.layer({
        model: options.model ?? DEFAULT_MODEL,
        config: {
          store: false,
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: options.reasoningEffort ?? "medium", summary: "auto" },
        },
      }).pipe(Layer.provide(layerClient)),
    ),
  );
