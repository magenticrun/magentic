import { Schema } from "effect";

/**
 * A name a surface or an identity provider registers under: short, lower
 * case, unique. Policy matches `surface:<name>` and `provider:<name>` by
 * string, so the sets are open; a bridge plugin names itself at registration
 * and the host checks the name against this shape.
 */
export const RegisteredName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/),
).annotate({ description: "a lower-case name: letters, digits and -, 2 to 32 characters" });

/** Where a request came from: `cli`, `slack`, `cursor`, or a bridge's own name such as `github`. */
export const Surface = RegisteredName.annotate({ description: "a surface name" });
export type Surface = typeof Surface.Type;

/** Which system vouched for the caller: `local`, `okta`, `slack`, or a bridge's provider such as `github`. */
export const IdentityProviderName = RegisteredName.annotate({
  description: "an identity provider name",
});
export type IdentityProviderName = typeof IdentityProviderName.Type;

/**
 * The person a machine principal acts for: a bridge run is `system:bridge/github`
 * on behalf of `github:12345`. Policy and audit see both.
 */
export const OnBehalfOf = Schema.Struct({
  /** Namespaced by provider, as `Principal.id` is: `github:12345`. */
  id: Schema.NonEmptyString,
  displayName: Schema.String,
});
export type OnBehalfOf = typeof OnBehalfOf.Type;

/** A resolved caller. Identity providers produce these; policy and audit consume them. */
export class Principal extends Schema.Class<Principal>("magentic/protocol/Principal")({
  id: Schema.NonEmptyString,
  displayName: Schema.String,
  email: Schema.optional(Schema.String),
  groups: Schema.Array(Schema.String),
  provider: IdentityProviderName,
  /** Set on `system:*` and `token:*` principals that act for a person. */
  onBehalfOf: Schema.optional(OnBehalfOf),
}) {}
