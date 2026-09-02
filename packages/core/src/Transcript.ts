import type { TranscriptEntry } from "@magentic/protocol";
import { Effect, Ref, type Schema } from "effect";
import { Chat, type Prompt } from "effect/unstable/ai";

/** Tool parts carry `unknown`; on the wire they were JSON, so that is what they still are. */
// SAFETY: tool parameters and results in a history were decoded from, and encode to, JSON.
const asJson = (value: Prompt.ToolCallPart["params"]) => value as Schema.Json;

/**
 * What was said, in order, from a chat history: each user text, each
 * assistant text, and each tool call with the result it got. Reasoning stays
 * out; the person never saw it as text.
 */
export const transcriptOf = (history: Prompt.Prompt): ReadonlyArray<TranscriptEntry> => {
  const entries: Array<TranscriptEntry> = [];
  const resolve = (id: string, result: Schema.Json, isFailure: boolean) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?._tag === "Tool" && entry.id === id) {
        entries[i] = { ...entry, result, isFailure };
        return;
      }
    }
  };
  for (const message of history.content) {
    switch (message.role) {
      case "user": {
        const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        if (text.length > 0) {
          entries.push({ _tag: "User", text: text.join("") });
        }
        break;
      }
      case "assistant":
        for (const part of message.content) {
          if (part.type === "text") {
            const last = entries.at(-1);
            if (last?._tag === "Assistant") {
              entries[entries.length - 1] = { _tag: "Assistant", text: last.text + part.text };
            } else {
              entries.push({ _tag: "Assistant", text: part.text });
            }
          } else if (part.type === "tool-call") {
            entries.push({
              _tag: "Tool",
              id: part.id,
              name: part.name,
              params: asJson(part.params),
              isFailure: false,
            });
          } else if (part.type === "tool-result") {
            resolve(part.id, asJson(part.result), part.isFailure);
          }
        }
        break;
      case "tool":
        for (const part of message.content) {
          if (part.type === "tool-result") {
            resolve(part.id, asJson(part.result), part.isFailure);
          }
        }
        break;
      case "system":
        break;
    }
  }
  return entries;
};

/** The transcript of a stored history, as `Chat.exportJson` wrote it. */
export const transcriptFromJson = Effect.fn("Transcript.fromJson")(function* (json: string) {
  const chat = yield* Chat.fromJson(json);
  return transcriptOf(yield* Ref.get(chat.history));
});
