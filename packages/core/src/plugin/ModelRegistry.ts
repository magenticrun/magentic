import {
  formatModelRef,
  type LoginError,
  type ModelInfo,
  type ModelProviderError,
  type ModelProviderRegistration,
  parseModelRef,
} from "@magentic/plugin";
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Semaphore } from "effect";
import { LanguageModel } from "effect/unstable/ai";

/** A model built for one `provider/model`, with the credentials it was built from. */
interface Built {
  /**
   * The provider's status line at build time. It names the key or account,
   * so a different line means the credentials changed and the model must be
   * built again; none means signed out.
   */
  readonly signature: string;
  readonly model: LanguageModel.Service;
  /** Closed when the model is replaced, releasing what its layer acquired. */
  readonly scope: Scope.Closeable;
}

/** No provider or model answers to a reference, in words the person who wrote it can act on. */
export class NoModelConfigured extends Schema.TaggedError<NoModelConfigured>()(
  "NoModelConfigured",
  { message: Schema.String },
) {}

export type ModelFailure = NoModelConfigured | LoginError | ModelProviderError;

/** The provider and model a reference lands on, before anything is built. */
export interface ResolvedModel {
  readonly provider: ModelProviderRegistration;
  readonly model: string;
  /** `provider/model`, the way an agent file would write it. */
  readonly ref: string;
}

/** The model providers plugins registered, in plugin order. */
export class ModelRegistry extends Context.Service<
  ModelRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ModelProviderRegistration>>;
    get(id: string): Effect.Effect<Option.Option<ModelProviderRegistration>>;
    /**
     * Where a `provider/model` reference lands. A bare provider id takes its
     * default model; none at all takes the first signed-in provider.
     */
    resolve(
      ref: Option.Option<string>,
    ): Effect.Effect<ResolvedModel, NoModelConfigured | LoginError>;
    /**
     * The model `resolve` lands on, built once per provider and model and
     * kept until the provider's credentials change or it signs out.
     */
    languageModel(ref: Option.Option<string>): Effect.Effect<LanguageModel.Service, ModelFailure>;
  }
>()("magentic/core/ModelRegistry") {}

/** Up to five ids worth showing next to "not found". */
const suggest = (known: ReadonlyArray<ModelInfo>, wanted: string): string => {
  const close = known.filter((m) => m.id.includes(wanted) || wanted.includes(m.id));
  const pick = (close.length > 0 ? close : known).slice(0, 5).map((m) => m.id);
  if (pick.length === 0) {
    return "";
  }
  const more = known.length > pick.length ? ", …" : "";
  return `; ${close.length > 0 ? "did you mean" : "known"}: ${pick.join(", ")}${more}`;
};

/** Builds the registry over the host's provider registrations; models live in `scope`. */
export const modelRegistryOver = (
  providers: Effect.Effect<ReadonlyArray<ModelProviderRegistration>>,
  scope: Scope.Scope,
): Effect.Effect<ModelRegistry["Service"]> =>
  Effect.gen(function* () {
    const built = new Map<string, Built>();
    const lock = yield* Semaphore.make(1);

    /** Forget a built model and release what its layer held. */
    const release = (key: string) =>
      Effect.gen(function* () {
        const stale = built.get(key);
        if (stale !== undefined) {
          built.delete(key);
          yield* Scope.close(stale.scope, Exit.void);
        }
      });

    const get = (id: string) =>
      Effect.map(providers, (all) => Option.fromNullishOr(all.find((p) => p.id === id)));

    /** The first provider that is signed in, in plugin order. */
    const firstSignedIn = Effect.gen(function* () {
      for (const provider of yield* providers) {
        if (Option.isSome(yield* provider.status)) {
          return provider;
        }
      }
      return yield* new NoModelConfigured({
        message: "no model provider is signed in; run `magentic auth login`",
      });
    });

    const named = Effect.fn("ModelRegistry.named")(function* (id: string) {
      const provider = yield* get(id);
      if (Option.isNone(provider)) {
        const ids = (yield* providers).map((p) => p.id).join(", ");
        return yield* new NoModelConfigured({
          message: `no model provider with id "${id}"; known: ${ids}`,
        });
      }
      return provider.value;
    });

    const build = Effect.fn("ModelRegistry.build")(function* (
      provider: ModelProviderRegistration,
      modelId: string,
    ) {
      const key = formatModelRef(provider.id, modelId);
      const notSignedIn = new NoModelConfigured({
        message: `${provider.name} is not signed in; run \`magentic auth login -p ${provider.id}\``,
      });
      // Read every time, so a logout or a new key in the store takes effect
      // on the next run rather than at the next restart.
      const status = yield* provider.status;
      if (Option.isNone(status)) {
        yield* release(key);
        return yield* notSignedIn;
      }
      const cached = built.get(key);
      if (cached !== undefined && cached.signature === status.value) {
        return cached.model;
      }
      yield* release(key);
      const known = yield* provider.models;
      if (!known.some((m) => m.id === modelId)) {
        return yield* new NoModelConfigured({
          message: `${provider.id} has no model "${modelId}"${suggest(known, modelId)}`,
        });
      }
      const layer = yield* provider.model(modelId);
      if (Option.isNone(layer)) {
        return yield* notSignedIn;
      }
      const modelScope = yield* Scope.fork(scope);
      const context = yield* Effect.result(
        Layer.build(layer.value).pipe(Effect.provideService(Scope.Scope, modelScope)),
      );
      if (context._tag === "Failure") {
        yield* Scope.close(modelScope, Exit.void);
        return yield* context.failure;
      }
      const model = Context.get(context.success, LanguageModel.LanguageModel);
      built.set(key, { signature: status.value, model, scope: modelScope });
      return model;
    });

    const resolve = Effect.fn("ModelRegistry.resolve")(function* (
      wanted: Option.Option<string>,
    ): Effect.fn.Return<ResolvedModel, NoModelConfigured | LoginError> {
      const ref = Option.map(wanted, parseModelRef);
      const provider = Option.isSome(ref) ? yield* named(ref.value.provider) : yield* firstSignedIn;
      const model = Option.isSome(ref)
        ? Option.getOrElse(ref.value.model, () => provider.defaultModel)
        : provider.defaultModel;
      return { provider, model, ref: formatModelRef(provider.id, model) };
    });

    const languageModel = Effect.fn("ModelRegistry.languageModel")(function* (
      wanted: Option.Option<string>,
    ) {
      const { provider, model } = yield* resolve(wanted);
      return yield* lock.withPermit(build(provider, model));
    });

    return ModelRegistry.of({ list: providers, get, resolve, languageModel });
  });
