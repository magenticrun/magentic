import {
  type LoginCancelled,
  type LoginError,
  type LoginMethod,
  type LoginUi,
  type ModelProviderRegistration,
  Screen,
} from "@magentic/plugin";
import { Effect, Option, Result, Schema } from "effect";

class NoSuchProvider extends Schema.TaggedError<NoSuchProvider>()("NoSuchProvider", {
  message: Schema.String,
}) {}

export interface LoginOptions {
  readonly ui: LoginUi;
  readonly providers: ReadonlyArray<ModelProviderRegistration>;
  /** Skip the provider picker. */
  readonly provider: Option.Option<string>;
  /** Skip the method picker. */
  readonly method: Option.Option<string>;
}

export interface LoginResult {
  readonly provider: ModelProviderRegistration;
  readonly method: LoginMethod;
  readonly summary: string;
}

export type LoginFailure = LoginError | LoginCancelled | NoSuchProvider;

const pickProvider = Effect.fn("Auth.pickProvider")(function* (options: LoginOptions) {
  if (Option.isSome(options.provider)) {
    const wanted = options.provider.value;
    const found = options.providers.find((p) => p.id === wanted);
    if (found === undefined) {
      const known = options.providers.map((p) => p.id).join(", ");
      return yield* new NoSuchProvider({
        message: `unknown provider "${wanted}"; known: ${known}`,
      });
    }
    return found;
  }
  const choices = yield* Effect.forEach(options.providers, (provider) =>
    Effect.map(provider.status, (status) => ({
      id: provider.id,
      name: provider.name,
      description: Option.match(status, {
        onNone: () => provider.description,
        onSome: (s) => `Signed in: ${s}`,
      }),
    })),
  );
  const chosen = yield* options.ui.choose("Sign in to a provider", choices);
  // SAFETY: choices were built one-to-one from options.providers with the same ids.
  return options.providers.find((p) => p.id === chosen.id) as ModelProviderRegistration;
});

const pickMethod = Effect.fn("Auth.pickMethod")(function* (
  options: LoginOptions,
  provider: ModelProviderRegistration,
) {
  if (Option.isSome(options.method)) {
    const wanted = options.method.value;
    const found = provider.methods.find((m) => m.id === wanted);
    if (found === undefined) {
      const known = provider.methods.map((m) => m.id).join(", ");
      return yield* new NoSuchProvider({
        message: `unknown method "${wanted}" for ${provider.id}; known: ${known}`,
      });
    }
    return found;
  }
  const [first, ...rest] = provider.methods;
  if (first !== undefined && rest.length === 0) {
    return first;
  }
  const chosen = yield* options.ui.choose(
    `${provider.name}: how do you want to sign in?`,
    provider.methods,
  );
  // SAFETY: the choices were provider.methods themselves, so the id is one of theirs.
  return provider.methods.find((m) => m.id === chosen.id) as LoginMethod;
});

/**
 * Drives one sign-in from picker to stored credential. The surface only
 * renders what it is told; everything that decides lives here so it can be
 * tested without a terminal.
 */
export const runLogin = Effect.fn("Auth.login")(function* (
  options: LoginOptions,
): Effect.gen.Return<LoginResult, LoginFailure> {
  const provider = yield* pickProvider(options);
  const method = yield* pickMethod(options, provider);
  const outcome = yield* Effect.result(method.run(options.ui));
  if (Result.isFailure(outcome)) {
    const error = outcome.failure;
    if (error._tag !== "LoginCancelled") {
      yield* options.ui.finish(Screen.Failed({ message: error.message }));
    }
    return yield* error;
  }
  const summary = outcome.success;
  yield* options.ui.finish(Screen.Done({ message: `Logged in to ${provider.name}: ${summary}` }));
  return { provider, method, summary };
});
