import { Effect, Predicate, Schema } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";

/**
 * Room to leave below the window for the next reply, after opencode; a model
 * whose output limit is smaller gets that instead.
 */
export const RESERVE_TOKENS = 20_000;
/** The most an automatic compaction keeps of the recent conversation word for word. */
export const KEEP_TOKENS = 8_000;
const TOOL_OUTPUT_MAX_CHARS = 2_000;
/** The runner's estimate rule. */
const CHARS_PER_TOKEN = 4;

/** Token limits from the model's catalog entry; 0 when it does not say. */
export interface ModelLimits {
  readonly context: number;
  readonly output: number;
}

export class CompactionError extends Schema.TaggedError<CompactionError>()("CompactionError", {
  reason: Schema.Literals(["nothing", "model", "store"]),
  message: Schema.String,
}) {}

/** What a compaction did: the context after it, the summary, and what the summary replaced. */
export interface Compaction {
  readonly context: Prompt.Prompt;
  readonly summary: string;
  /** The messages the summary stands for, an earlier summary included, in order. */
  readonly dropped: ReadonlyArray<Prompt.Message>;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
}

/**
 * A stored history holds everything ever said, so surfaces can show it all.
 * The model sees the context: the system prompt, the latest summary, and
 * what came after it. Everything between is archived.
 */
export interface Partitioned {
  readonly archived: ReadonlyArray<Prompt.Message>;
  readonly context: Prompt.Prompt;
}

export const partition = (full: Prompt.Prompt): Partitioned => {
  const messages = full.content;
  const last = messages.findLastIndex(isSummary);
  if (last < 0) {
    return { archived: [], context: full };
  }
  const system = messages.filter((message) => message.role === "system");
  const archived = messages.slice(0, last).filter((message) => message.role !== "system");
  return { archived, context: Prompt.fromMessages([...system, ...messages.slice(last)]) };
};

/** The whole history again: the system prompt, the archive, then the context. */
export const join = (
  archived: ReadonlyArray<Prompt.Message>,
  context: Prompt.Prompt,
): Prompt.Prompt => {
  const system = context.content.filter((message) => message.role === "system");
  const rest = context.content.filter((message) => message.role !== "system");
  return Prompt.fromMessages([...system, ...archived, ...rest]);
};

/** Tokens a conversation may hold before the next reply risks the window; 0 when the window is unknown. */
export const usable = ({ context, output }: ModelLimits): number =>
  context <= 0
    ? 0
    : Math.max(0, context - Math.min(RESERVE_TOKENS, output > 0 ? output : RESERVE_TOKENS));

/** Whether a conversation holding `held` tokens should be compacted before the model is called again. */
export const isOverflow = (held: number, limits: ModelLimits): boolean => {
  const room = usable(limits);
  return room > 0 && held >= room;
};

/** What an automatic compaction keeps word for word: a quarter of the room, up to the cap. */
export const keepFor = (limits: ModelLimits): number =>
  Math.min(KEEP_TOKENS, Math.floor(usable(limits) / 4));

const estimate = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const truncate = (text: string): string =>
  text.length <= TOOL_OUTPUT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;

const toolResult = (part: Prompt.ToolResultPart): string =>
  `[Tool ${part.isFailure ? "error" : "result"}]: ${truncate(JSON.stringify(part.result) ?? "")}`;

/** One message the way the summariser reads it, after opencode; empty for what it need not see. */
const serialise = (message: Prompt.Message): string => {
  switch (message.role) {
    case "system":
      return "";
    case "user": {
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const files = message.content.flatMap((part) =>
        part.type === "file"
          ? [
              `[Attached ${part.mediaType}${part.fileName === undefined ? "" : `: ${part.fileName}`}]`,
            ]
          : [],
      );
      return [...(text.length > 0 ? [`[User]: ${text}`] : []), ...files].join("\n");
    }
    case "assistant":
      return message.content
        .flatMap((part) => {
          switch (part.type) {
            case "text":
              return part.text.length > 0 ? [`[Assistant]: ${part.text}`] : [];
            case "reasoning":
              return part.text.length > 0 ? [`[Assistant reasoning]: ${part.text}`] : [];
            case "tool-call":
              return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.params)})`];
            case "tool-result":
              return [toolResult(part)];
            default:
              return [];
          }
        })
        .join("\n");
    case "tool":
      return message.content
        .flatMap((part) => (part.type === "tool-result" ? [toolResult(part)] : []))
        .join("\n");
  }
};

// The summary lives in the history as a user message marked in its options,
// under our own key, which the providers' clients leave alone. It is one text
// part with the framing in front: `Chat.exportJson` keeps only the first text
// part of a user message.
const MARK = "magentic";
const FRAMING =
  "The conversation so far was compacted into the summary below to free context. Continue from it as if you had been there; do not mention the compaction.\n\n";

/** A user message that carries a summary of what came before it. */
export const isSummary = (message: Prompt.Message): boolean => {
  if (message.role !== "user") {
    return false;
  }
  const mark = message.options[MARK];
  return Predicate.hasProperty(mark, "summary") && mark.summary === true;
};

/** The summary a summary message carries, without the framing. */
export const summaryOf = (message: Prompt.UserMessage): string => {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  return text.startsWith(FRAMING) ? text.slice(FRAMING.length) : text;
};

const summaryMessage = (summary: string): Prompt.UserMessage =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text: `${FRAMING}${summary}` })],
    options: { [MARK]: { summary: true } },
  });

/**
 * The recent turns, each from a user message to the next, that fit in `keep`
 * tokens; everything before them is the head that gets summarised.
 */
const split = (messages: ReadonlyArray<Prompt.Message>, keep: number) => {
  let cut = messages.length;
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") {
      continue;
    }
    const size = estimate(messages.slice(i, cut).map(serialise).join("\n\n"));
    if (total + size > keep) {
      break;
    }
    total += size;
    cut = i;
  }
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
};

const SUMMARISER =
  "You summarise a conversation between a person and a coding agent so that another agent can continue the work.";

/** opencode's summary shape, so the next agent finds the same sections every time. */
const TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const UPDATE = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`;

const buildPrompt = (previous: string | undefined, conversation: string): string => {
  const wrapped = `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`;
  if (previous === undefined) {
    return [
      wrapped,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      TEMPLATE,
    ].join("\n\n");
  }
  return [
    wrapped,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${previous}\n</prior-summary>`,
    UPDATE,
    TEMPLATE,
  ].join("\n\n");
};

/**
 * Fold a context into its system prompt, one summary message, and the most
 * recent `keep` tokens of turns kept as they were. An earlier summary is
 * carried into the new one. The model in context writes the summary.
 */
export const compactContext = Effect.fn("Compaction.compactContext")(function* (
  context: Prompt.Prompt,
  keep: number,
) {
  const messages = context.content;
  const system = messages.filter((message) => message.role === "system");
  const last = messages.findLastIndex(isSummary);
  const previousMessage = last < 0 ? undefined : messages[last];
  // Only a user message answers to isSummary, so the role check is for the types.
  const previous = previousMessage?.role === "user" ? summaryOf(previousMessage) : undefined;
  const since = messages.slice(last + 1).filter((message) => message.role !== "system");
  // When the recent turns alone fill the budget, all of them go into the summary.
  const kept = split(since, keep);
  const { head, tail } = kept.head.length === 0 && keep > 0 ? split(since, 0) : kept;
  if (head.length === 0) {
    return yield* new CompactionError({ reason: "nothing", message: "Nothing to compact yet" });
  }
  const conversation = head
    .map(serialise)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const response = yield* LanguageModel.generateText({
    prompt: [
      { role: "system", content: SUMMARISER },
      { role: "user", content: buildPrompt(previous, conversation) },
    ],
  }).pipe(
    Effect.mapError((error) => new CompactionError({ reason: "model", message: error.message })),
  );
  const summary = response.text.trim();
  if (summary.length === 0) {
    return yield* new CompactionError({
      reason: "model",
      message: "The model returned an empty summary",
    });
  }
  const compacted = Prompt.fromMessages([...system, summaryMessage(summary), ...tail]);
  const result: Compaction = {
    context: compacted,
    summary,
    dropped: [...(previousMessage === undefined ? [] : [previousMessage]), ...head],
    messagesBefore: messages.length,
    messagesAfter: compacted.content.length,
  };
  return result;
});
