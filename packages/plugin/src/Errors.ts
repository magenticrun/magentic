import { Predicate } from "effect";

/**
 * Where an error keeps the one it wraps. `RpcClientError` calls it `reason`;
 * everything else calls it `cause`.
 */
const WRAPPERS = ["cause", "reason"] as const;

/** How far to follow wrapped errors, so a chain that loops cannot spin here. */
const DEPTH = 8;

/**
 * A message with nothing of its own in it. `RpcClientError` renders its
 * reason's tag and then the reason's `message`, and the serialised HTTP
 * error it carries has none of its own, so a dropped connection arrives as
 * the bare `"HttpError: "` with the real words one level further down.
 */
const saysNothing = (text: string): boolean => text === "" || text.endsWith(":");

/** What a value says for itself, with no regard for what it wraps. */
const spoken = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message.trim()
    : String(cause).trim();

/** The message, following what an error wraps while it says nothing itself. */
const said = (cause: unknown, depth: number): string => {
  const own = spoken(cause);
  if (depth <= 0 || !saysNothing(own)) {
    return own;
  }
  for (const key of WRAPPERS) {
    if (Predicate.hasProperty(cause, key) && Predicate.isNotNullish(cause[key])) {
      const rest = said(cause[key], depth - 1);
      return rest === "" || own === "" ? `${own}${rest}` : `${own} ${rest}`;
    }
  }
  return own;
};

/**
 * The message a thrown or rejected value carries: an Error's own, anything
 * else as text. One that says only a tag hands over to the error it wraps,
 * so a transport failure reads as what went wrong rather than `HttpError:`.
 */
export const messageOf = (cause: unknown): string => said(cause, DEPTH);
