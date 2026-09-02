import { messageOf } from "@magentic/plugin";
import { Cause } from "effect";

/** The message a person sees when something dies; never a stack. */
export const describeCause = (cause: Cause.Cause<unknown>): string =>
  messageOf(Cause.squash(cause));
