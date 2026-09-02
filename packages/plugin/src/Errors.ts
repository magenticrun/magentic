import { Predicate } from "effect";

/** The message a thrown or rejected value carries: an Error's own, anything else as text. */
export const messageOf = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);
