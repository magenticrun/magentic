import { Data, type Effect, type Layer, Option, type Redacted, Schema, type Scope } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { CatalogModel } from "./Catalog.ts";
import type { Registration } from "./Plugin.ts";

/** One row in a picker: a provider or a sign-in method. */
export interface Choice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Progress and outcome messages a sign-in reports while it runs. */
export type Screen = Data.TaggedEnum<{
  DeviceCode: { readonly url: string; readonly code: string };
  Busy: { readonly message: string };
  Done: { readonly message: string };
  Failed: { readonly message: string };
}>;
export const Screen = Data.taggedEnum<Screen>();

export class LoginCancelled extends Schema.TaggedError<LoginCancelled>()("LoginCancelled", {}) {}

/** A sign-in that could not complete, already in words a person can act on. */
export class LoginError extends Schema.TaggedError<LoginError>()("LoginError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/** A provider that is signed in but cannot produce a working model. */
export class ModelProviderError extends Schema.TaggedError<ModelProviderError>()(
  "ModelProviderError",
  { provider: Schema.String, message: Schema.String },
) {}

/**
 * The sign-in surface as a login method sees it. The CLI implements it with
 * prompts; tests script it. Methods only report; they never print.
 */
export interface LoginUi {
  choose(title: string, choices: ReadonlyArray<Choice>): Effect.Effect<Choice, LoginCancelled>;
  secret(
    title: string,
    placeholder: string,
  ): Effect.Effect<Redacted.Redacted<string>, LoginCancelled>;
  /** Report progress without waiting: device codes and busy messages. */
  show(screen: Screen): Effect.Effect<void>;
  /** Report the outcome. */
  finish(screen: Screen): Effect.Effect<void>;
}

/** One way to sign in to a provider. `run` returns a one-line summary of what was stored. */
export interface LoginMethod extends Choice {
  run(ui: LoginUi): Effect.Effect<string, LoginError | LoginCancelled>;
}

/** One model a provider can serve. */
export class ModelInfo extends Schema.Class<ModelInfo>("magentic/plugin/ModelInfo")({
  id: Schema.NonEmptyString,
  name: Schema.String,
  reasoning: Schema.Boolean,
  toolCall: Schema.Boolean,
  /** Token limits; 0 when the catalog does not say. */
  context: Schema.Finite,
  output: Schema.Finite,
}) {
  static readonly fromCatalog = (model: CatalogModel): ModelInfo =>
    new ModelInfo({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      toolCall: model.tool_call ?? true,
      context: model.limit?.context ?? 0,
      output: model.limit?.output ?? 0,
    });
}

/** A parsed model reference: a provider id, and a model id when one was given. */
export interface ModelRef {
  readonly provider: string;
  readonly model: Option.Option<string>;
}

/**
 * `"anthropic"` names a provider and takes its default model;
 * `"anthropic/claude-sonnet-5"` names both. Only the first slash splits, so
 * model ids may contain slashes of their own.
 */
export const parseModelRef = (ref: string): ModelRef => {
  const at = ref.indexOf("/");
  return at < 0
    ? { provider: ref, model: Option.none() }
    : { provider: ref.slice(0, at), model: Option.some(ref.slice(at + 1)) };
};

export const formatModelRef = (provider: string, model: string): string => `${provider}/${model}`;

/**
 * A model provider: how to sign in, whether we are, which models it serves,
 * and the layer for one of them. Agents pick a provider and a model with a
 * `provider/model` reference; a bare provider id takes `defaultModel`.
 */
export interface ModelProviderRegistration extends Choice {
  readonly methods: ReadonlyArray<LoginMethod>;
  /**
   * A one-line summary when signed in, none otherwise. It should name the
   * credential (a key hint, an account): the host rebuilds a provider's
   * models when this line changes, and drops them when it goes to none.
   */
  readonly status: Effect.Effect<Option.Option<string>, LoginError>;
  readonly logout: Effect.Effect<void, LoginError>;
  /** The models this provider can serve, in the order a picker should show them. */
  readonly models: Effect.Effect<ReadonlyArray<ModelInfo>>;
  /** Used when an agent names the provider alone. One of `models`. */
  readonly defaultModel: string;
  /** The layer for one of `models`; None when not signed in. Built once per credential state. */
  model(
    id: string,
  ): Effect.Effect<
    Option.Option<Layer.Layer<LanguageModel.LanguageModel, ModelProviderError>>,
    LoginError
  >;
}

export interface ModelDomain {
  register(provider: ModelProviderRegistration): Effect.Effect<Registration, never, Scope.Scope>;
  /** Every provider registered so far, in plugin order. */
  readonly providers: Effect.Effect<ReadonlyArray<ModelProviderRegistration>>;
}
