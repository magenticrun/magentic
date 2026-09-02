import type { ContextBreakdown } from "@magentic/protocol";
import { type Prompt, Tool } from "effect/unstable/ai";

/** opencode's rule of thumb; close enough for a bar, not for billing. */
const CHARS_PER_TOKEN = 4;

const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** How long a value is once serialised the way a provider would see it. */
const jsonLength = (value: Parameters<typeof JSON.stringify>[0]): number =>
  JSON.stringify(value)?.length ?? 0;

/**
 * Where the context goes: the system prompt, the tool definitions the model
 * is offered, and the history by who wrote it. Providers report one input
 * total, so this is estimated from characters.
 */
export const estimateContext = (
  history: Prompt.Prompt,
  tools: Record<string, Tool.Any>,
): ContextBreakdown => {
  let system = 0;
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  for (const message of history.content) {
    switch (message.role) {
      case "system":
        system += message.content.length;
        break;
      case "user":
        for (const part of message.content) {
          if (part.type === "text") {
            user += part.text.length;
          }
        }
        break;
      case "assistant":
        for (const part of message.content) {
          if (part.type === "text" || part.type === "reasoning") {
            assistant += part.text.length;
          } else if (part.type === "tool-call") {
            toolCalls += jsonLength(part.params);
          } else if (part.type === "tool-result") {
            toolCalls += jsonLength(part.result);
          }
        }
        break;
      case "tool":
        for (const part of message.content) {
          if (part.type === "tool-result") {
            toolCalls += jsonLength(part.result);
          }
        }
        break;
    }
  }
  let definitions = 0;
  for (const tool of Object.values(tools)) {
    definitions +=
      tool.name.length +
      (Tool.getDescription(tool) ?? "").length +
      jsonLength(Tool.getJsonSchema(tool));
  }
  return {
    system: tokens(system),
    tools: tokens(definitions),
    toolCount: Object.keys(tools).length,
    user: tokens(user),
    assistant: tokens(assistant),
    toolCalls: tokens(toolCalls),
    messages: history.content.length,
  };
};
