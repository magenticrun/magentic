import { Schema } from "effect";

/** What may name a conversation on the wire and on disk: one path segment, no dots, no separators. */
export const ConversationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/),
).annotate({ description: "letters, digits, _ and -; a UUID fits" });
export type ConversationId = typeof ConversationId.Type;
