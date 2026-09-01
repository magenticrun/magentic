import { type IdentityProviderName, Principal } from "@magentic/protocol";
import { Context, Effect, Layer, Schema } from "effect";

export class IdentityError extends Schema.TaggedError<IdentityError>()("IdentityError", {
  subject: Schema.String,
  message: Schema.String,
}) {}

/** The caller of the current request, once identity has resolved it. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "magentic/identity/CurrentPrincipal",
) {}

/** Turns a surface-specific subject (Slack user id, OS user, …) into a Principal. */
export class Identity extends Context.Service<
  Identity,
  {
    readonly provider: IdentityProviderName;
    resolve(subject: string): Effect.Effect<Principal, IdentityError>;
  }
>()("magentic/identity/Identity") {
  /** Trusts whatever subject it is handed. Only appropriate on your own box. */
  static readonly layerLocal = Layer.succeed(
    Identity,
    Identity.of({
      provider: "local",
      resolve: (subject) =>
        Effect.succeed(
          new Principal({
            id: `local:${subject}`,
            displayName: subject,
            groups: [],
            provider: "local",
          }),
        ),
    }),
  );
}
