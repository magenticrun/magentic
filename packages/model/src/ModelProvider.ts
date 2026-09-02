/** Defaults per provider until `magentic.yaml` chooses. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_ZAI_MODEL = "glm-5.3-flash";
export const DEFAULT_ZEN_MODEL = "claude-sonnet-5";

/**
 * Z.AI's Anthropic Messages endpoint. Their OpenAI-compatible endpoint only
 * serves chat completions, and Effect's OpenAI client speaks the Responses
 * API, so GLM goes through the Anthropic client instead.
 */
export const ZAI_ANTHROPIC_URL = "https://api.z.ai/api/anthropic";

/**
 * OpenCode Zen serves Claude models on its Anthropic Messages route at
 * `/zen/v1/messages`; the client appends `/v1/messages` itself.
 */
export const ZEN_ANTHROPIC_URL = "https://opencode.ai/zen";

/** OpenCode Zen's OpenAI Responses route; the client appends `/responses`. */
export const ZEN_OPENAI_URL = "https://opencode.ai/zen/v1";
