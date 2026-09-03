import { Predicate } from "effect";
import { Prompt } from "effect/unstable/ai";

/**
 * User messages the harness wrote rather than the person, marked in their
 * options under our own key, which the providers' clients leave alone: the
 * summary a compaction left, and the notices a run folded in. Each is one
 * text part with its framing in front, since `Chat.exportJson` keeps only
 * the first text part of a user message.
 */
const MARK = "magentic";

const marked = (message: Prompt.Message, flag: "summary" | "notice"): boolean => {
  if (message.role !== "user") {
    return false;
  }
  const mark = message.options[MARK];
  return Predicate.hasProperty(mark, flag) && mark[flag] === true;
};

const textOf = (message: Prompt.UserMessage): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

const unframe = (text: string, framing: string): string =>
  text.startsWith(framing) ? text.slice(framing.length) : text;

const SUMMARY_FRAMING =
  "The conversation so far was compacted into the summary below to free context. Continue from it as if you had been there; do not mention the compaction.\n\n";

/** A user message that carries a summary of what came before it. */
export const isSummary = (message: Prompt.Message): boolean => marked(message, "summary");

/** The summary a summary message carries, without the framing. */
export const summaryOf = (message: Prompt.UserMessage): string =>
  unframe(textOf(message), SUMMARY_FRAMING);

export const summaryMessage = (summary: string): Prompt.UserMessage =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text: `${SUMMARY_FRAMING}${summary}` })],
    options: { [MARK]: { summary: true } },
  });

const NOTICE_FRAMING = "From the harness, not the person, while you worked:\n\n";

/** A user message that carries notices from the harness. */
export const isNotice = (message: Prompt.Message): boolean => marked(message, "notice");

/** The notices a notice message carries, without the framing. */
export const noticeOf = (message: Prompt.UserMessage): string =>
  unframe(textOf(message), NOTICE_FRAMING);

/** The notices as one message, a blank line between them. */
export const noticeMessage = (notices: ReadonlyArray<string>): Prompt.UserMessage =>
  Prompt.makeMessage("user", {
    content: [Prompt.makePart("text", { text: `${NOTICE_FRAMING}${notices.join("\n\n")}` })],
    options: { [MARK]: { notice: true } },
  });
