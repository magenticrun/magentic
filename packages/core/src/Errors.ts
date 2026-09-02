import { Cause, Predicate } from "effect";

/** The message a person sees when something dies; never a stack. */
export const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }
  return String(error);
};
