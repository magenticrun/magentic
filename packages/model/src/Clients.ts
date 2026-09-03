import { Effect } from "effect";

/**
 * Effect's provider clients are the heaviest modules the CLI would load, and
 * a chat only talks to one of them, through the gateway. Each is imported
 * the first time a model on its protocol is built, so neither is on the way
 * to the first paint. Bun keeps the module after the first import; later
 * calls resolve from its cache.
 */
export const anthropic = Effect.promise(() => import("@effect/ai-anthropic"));

export const openai = Effect.promise(() => import("@effect/ai-openai"));

export const openaiCompat = Effect.promise(() => import("@effect/ai-openai-compat"));
