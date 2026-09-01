import { Schema } from "effect";

/** Where a request came from. Every surface maps onto one of these. */
export const Surface = Schema.Literals(["slack", "cli", "cursor"]);
export type Surface = typeof Surface.Type;

/** Which system vouched for the caller. */
export const IdentityProviderName = Schema.Literals(["slack", "okta", "local"]);
export type IdentityProviderName = typeof IdentityProviderName.Type;

/** A resolved caller. Identity providers produce these; policy and audit consume them. */
export class Principal extends Schema.Class<Principal>("magentic/protocol/Principal")({
  id: Schema.NonEmptyString,
  displayName: Schema.String,
  email: Schema.optional(Schema.String),
  groups: Schema.Array(Schema.String),
  provider: IdentityProviderName,
}) {}
