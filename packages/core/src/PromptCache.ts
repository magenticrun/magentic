import { Config, Predicate } from "effect";
import { Prompt } from "effect/unstable/ai";

/**
 * Whether a run asks Anthropic to keep the prefix it has already sent, and
 * for how long. `short` is the API's own five minutes; `long` asks for an
 * hour, which costs more to write and pays off on a conversation picked up
 * later. `none` sends no markers at all, for a compatible endpoint that
 * refuses them: the calls still go out, and every token is charged as new.
 */
export type CacheRetention = "none" | "short" | "long";

export const cacheRetention: Config.Config<CacheRetention> = Config.Literals(
  ["none", "short", "long"],
  "MAGENTIC_PROMPT_CACHE",
).pipe(Config.withDefault("short"));

/** Provider options, as every message carries them. */
type Options = Prompt.Message["options"];

/**
 * The breakpoint a block carries, as the client's own options type spells it,
 * or none when this call marks no block at all.
 */
type Marker = { readonly type: "ephemeral"; readonly ttl?: "5m" | "1h" } | undefined;

const markerFor = (retention: CacheRetention): Marker => {
  switch (retention) {
    case "none":
      return undefined;
    case "short":
      return { type: "ephemeral" };
    case "long":
      return { type: "ephemeral", ttl: "1h" };
  }
};

/**
 * The options carrying `marker`, or none. Anything else the provider put
 * under `anthropic` stays as it was: a reasoning signature lives there too,
 * and a thought whose signature went missing is one the model refuses. The
 * options themselves come back when nothing about them changed, so a message
 * that was already right is left alone.
 */
const withMarker = (options: Options, marker: Marker): Options => {
  const anthropic = options["anthropic"];
  if (marker === undefined) {
    if (Predicate.isNullish(anthropic) || Predicate.isNullish(anthropic.cacheControl)) {
      return options;
    }
    const { cacheControl: _dropped, ...kept } = anthropic;
    return { ...options, anthropic: kept };
  }
  return { ...options, anthropic: { ...anthropic, cacheControl: marker } };
};

/** The last message `ok` holds for, or -1 when none does. */
const lastIndexWhere = (
  content: ReadonlyArray<Prompt.Message>,
  ok: (message: Prompt.Message) => boolean,
): number => {
  for (let index = content.length - 1; index >= 0; index--) {
    const message = content[index];
    if (message !== undefined && ok(message)) {
      return index;
    }
  }
  return -1;
};

/**
 * A marker is read off a system, user or tool-result message. On an assistant
 * message rc.115 reads one and throws it away, and a step never ends on one:
 * the model is called after something was said to it or after a tool
 * answered, never after it spoke.
 */
const isTail = (message: Prompt.Message): boolean =>
  message.role === "user" || message.role === "tool";

const remark = (prompt: Prompt.Prompt, markerAt: (index: number) => Marker): Prompt.Prompt => {
  let changed = false;
  const content = prompt.content.map((message, index) => {
    const options = withMarker(message.options, markerAt(index));
    if (options === message.options) {
      return message;
    }
    changed = true;
    return { ...message, options };
  });
  return changed ? Prompt.fromMessages(content) : prompt;
};

/** The two halves of a call, each carrying the markers that call wants. */
interface CachedCall {
  readonly history: Prompt.Prompt;
  readonly input: Prompt.Prompt;
}

/**
 * Where a call asks Anthropic to start reading rather than read again: the
 * history and the input, each with the markers this call wants and none of
 * the ones an earlier one left.
 *
 * Two markers are enough for an agent loop. One sits on the system prompt,
 * which covers the tool definitions as well: a request is ordered tools,
 * then system, then messages, and a marker keeps everything ahead of it. The
 * other sits on the last thing the model has been told — in the input when
 * this call carries one, in the history when it does not — and so moves
 * forward a step at a time, each call reading the prefix the one before it
 * wrote.
 *
 * Four markers is the API's limit, and ones left where earlier steps put them
 * would pile up past it, so every call clears them all before setting its
 * own. That also cleans a history read back from disk, which was saved with
 * the markers of whatever call ended the run before.
 *
 * Nothing but the Anthropic client looks under `anthropic`, so a marked
 * prompt reaches every other provider exactly as it would have.
 */
export const withCachePoints = (
  history: Prompt.Prompt,
  input: Prompt.RawInput,
  retention: CacheRetention,
): CachedCall => {
  const marker = markerFor(retention);
  const prompt = Prompt.make(input);
  const system = lastIndexWhere(history.content, (message) => message.role === "system");
  const inInput = lastIndexWhere(prompt.content, isTail);
  const inHistory = inInput === -1 ? lastIndexWhere(history.content, isTail) : -1;
  return {
    history: remark(history, (index) =>
      index === system || index === inHistory ? marker : undefined,
    ),
    input: remark(prompt, (index) => (index === inInput ? marker : undefined)),
  };
};
