import {
  type CatalogModel,
  define,
  LoginError,
  type LoginMethod,
  ModelCatalog,
  ModelInfo,
  ModelProviderError,
  type Plugin,
} from "@magentic/plugin";
import { Effect, Layer, Option, type Redacted } from "effect";
import { reasoningContext } from "../Reasoning.ts";
import { LanguageModel } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import { apiKeyHint, type ApiKeyProvider, ApiKeyStore } from "../ApiKeys.ts";
import * as Clients from "../Clients.ts";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ZAI_MODEL,
  DEFAULT_ZEN_MODEL,
  ZAI_ANTHROPIC_URL,
  ZEN_ANTHROPIC_URL,
  ZEN_OPENAI_URL,
} from "../ModelProvider.ts";
import { anthropicCompatibleClient } from "./AnthropicCompat.ts";

/**
 * How to reach one model: the wire protocol Effect has a client for, and the
 * base URL when it is not the protocol owner's. `compatible` marks endpoints
 * that imitate Anthropic and may leave out fields Anthropic always sends.
 * `openai-compat` is chat completions, which everyone but OpenAI speaks.
 */
export interface ModelRoute {
  readonly protocol: "anthropic" | "openai-responses" | "openai-compat";
  readonly url?: string;
  readonly compatible?: boolean;
}

interface ApiKeyPluginOptions {
  readonly provider: ApiKeyProvider;
  /** The provider's id on models.dev, which lists its models. */
  readonly catalog: string;
  readonly name: string;
  readonly description: string;
  /** Where a person creates the key. */
  readonly keyUrl: string;
  readonly defaultModel: string;
  /** None means the model is listed by the catalog but we cannot reach it. */
  readonly route: (model: CatalogModel) => Option.Option<ModelRoute>;
}

const hidden = (model: CatalogModel) => model.status === "deprecated" || model.status === "alpha";

/** The client for the route's protocol is loaded when the layer is first built. */
const layerFor = (
  route: ModelRoute,
  model: string,
  apiKey: Redacted.Redacted<string>,
  http: HttpClient.HttpClient,
): Layer.Layer<LanguageModel.LanguageModel> => {
  const withHttp = Layer.succeed(HttpClient.HttpClient, http);
  switch (route.protocol) {
    case "anthropic":
      return Layer.unwrap(
        Effect.map(Clients.anthropic, ({ AnthropicClient, AnthropicLanguageModel }) =>
          AnthropicLanguageModel.layer({ model }).pipe(
            Layer.provide(
              AnthropicClient.layer({
                apiKey,
                apiUrl: route.url,
                transformClient: route.compatible === true ? anthropicCompatibleClient : undefined,
              }).pipe(Layer.provide(withHttp)),
            ),
          ),
        ),
      );
    case "openai-responses":
      return Layer.unwrap(
        Effect.map(Clients.openai, ({ OpenAiClient, OpenAiLanguageModel }) =>
          OpenAiLanguageModel.layer({ model }).pipe(
            Layer.provide(
              OpenAiClient.layer({ apiKey, apiUrl: route.url }).pipe(Layer.provide(withHttp)),
            ),
          ),
        ),
      );
    case "openai-compat":
      return Layer.unwrap(
        Effect.map(Clients.openaiCompat, ({ OpenAiClient, OpenAiLanguageModel }) =>
          OpenAiLanguageModel.layer({ model }).pipe(
            Layer.provide(
              OpenAiClient.layer({ apiKey, apiUrl: route.url }).pipe(Layer.provide(withHttp)),
            ),
          ),
        ),
      );
  }
};

/** A provider that takes a pasted API key: one login method, one stored key, models from the catalog. */
const apiKeyPlugin = (
  options: ApiKeyPluginOptions,
): Plugin<ApiKeyStore | HttpClient.HttpClient | ModelCatalog> => {
  const id = options.provider;
  const failed = (error: { readonly message: string }) =>
    new LoginError({ provider: id, message: error.message });
  return define<ApiKeyStore | HttpClient.HttpClient | ModelCatalog>({
    id,
    description: options.description,
    setup: Effect.fn(`${id}Plugin.setup`)(function* (ctx) {
      const store = yield* ApiKeyStore;
      const http = yield* HttpClient.HttpClient;
      const catalog = yield* ModelCatalog;

      const pasteKey: LoginMethod = {
        id: "api-key",
        name: "Paste an API key",
        description: `Stored with mode 0600 for the ${options.name} API.`,
        run: Effect.fn(`${id}.apiKey`)(function* (ui) {
          const key = yield* ui.secret(
            `${options.name} API key`,
            `create one at ${options.keyUrl}, paste it and press enter`,
          );
          yield* store.set(options.provider, key).pipe(Effect.mapError(failed));
          return `API key ${apiKeyHint(key)}`;
        }),
      };

      const key = store.get(options.provider).pipe(Effect.mapError(failed));

      /** Catalog models we can reach, by id. */
      const routed = Effect.map(catalog.provider(options.catalog), (found) =>
        Option.match(found, {
          onNone: () => [],
          onSome: (provider) =>
            Object.values(provider.models)
              .toSorted((a, b) => a.id.localeCompare(b.id))
              .flatMap((model) => {
                if (hidden(model)) {
                  return [];
                }
                const route = options.route(model);
                return Option.isNone(route) ? [] : [{ model, route: route.value }];
              }),
        }),
      );

      const routeFor = (modelId: string) =>
        Effect.map(routed, (all) => {
          const listed = all.find((entry) => entry.model.id === modelId);
          // A model the catalog does not know yet still gets the provider's usual route.
          return listed === undefined
            ? options.route({ id: modelId, name: modelId })
            : Option.some(listed.route);
        });

      /** The request configuration for a thinking level, in the protocol the model's route speaks. */
      const reasoning = (modelId: string, level: string) =>
        Effect.flatMap(routed, (all) => {
          const listed = all.find((entry) => entry.model.id === modelId);
          return listed === undefined
            ? Effect.succeedNone
            : reasoningContext(listed.route.protocol, listed.model, level);
        });

      yield* ctx.model.register({
        id,
        name: options.name,
        description: options.description,
        methods: [pasteKey],
        status: Effect.map(
          key,
          Option.map((k) => `API key ${apiKeyHint(k)}`),
        ),
        logout: store.remove(options.provider).pipe(Effect.mapError(failed)),
        models: Effect.map(routed, (all) => all.map(({ model }) => ModelInfo.fromCatalog(model))),
        defaultModel: options.defaultModel,
        model: (modelId) =>
          Effect.gen(function* () {
            const k = yield* key;
            if (Option.isNone(k)) {
              return Option.none();
            }
            const route = yield* routeFor(modelId);
            if (Option.isNone(route)) {
              return Option.some(
                Layer.effect(
                  LanguageModel.LanguageModel,
                  new ModelProviderError({
                    provider: id,
                    message: `${options.name} lists "${modelId}" but magentic has no client for its protocol`,
                  }),
                ),
              );
            }
            return Option.some(layerFor(route.value, modelId, k.value, http));
          }),
        reasoning,
      });
    }),
  });
};

const OPENAI_RESPONSES: ModelRoute = { protocol: "openai-responses" };
const ANTHROPIC: ModelRoute = { protocol: "anthropic" };

export const openaiPlugin = apiKeyPlugin({
  provider: "openai",
  catalog: "openai",
  name: "OpenAI (API key)",
  description: "Pay per token with a key from platform.openai.com.",
  keyUrl: "https://platform.openai.com/api-keys",
  defaultModel: DEFAULT_OPENAI_MODEL,
  // The catalog also lists image, audio, and embedding models; agents need tool calls.
  route: (model) => (model.tool_call === false ? Option.none() : Option.some(OPENAI_RESPONSES)),
});

export const anthropicPlugin = apiKeyPlugin({
  provider: "anthropic",
  catalog: "anthropic",
  name: "Anthropic (API key)",
  description: "Pay per token with a key from console.anthropic.com.",
  keyUrl: "https://console.anthropic.com/settings/keys",
  defaultModel: DEFAULT_ANTHROPIC_MODEL,
  route: () => Option.some(ANTHROPIC),
});

/**
 * Z.AI's own API is OpenAI chat completions, which Effect has no client for;
 * every GLM model is also served on their Anthropic-compatible route.
 */
export const zaiPlugin = apiKeyPlugin({
  provider: "zai",
  catalog: "zai",
  name: "Z.AI (API key)",
  description: "GLM models with a key from z.ai; a GLM Coding Plan key works too.",
  keyUrl: "https://z.ai/manage-apikey/apikey-list",
  defaultModel: DEFAULT_ZAI_MODEL,
  route: () => Option.some({ protocol: "anthropic", url: ZAI_ANTHROPIC_URL, compatible: true }),
});

/**
 * OpenCode Zen fronts many vendors behind one key. The catalog says which
 * protocol each model speaks; Claude goes through Anthropic Messages and GPT
 * through OpenAI Responses. Everything else — Gemini, the open-weight models —
 * goes through chat completions, which Zen serves at the same base URL.
 */
export const opencodeZenPlugin = apiKeyPlugin({
  provider: "opencode-zen",
  catalog: "opencode",
  name: "OpenCode Zen (API key)",
  description: "Many vendors' models behind one key from opencode.ai.",
  keyUrl: "https://opencode.ai/auth",
  defaultModel: DEFAULT_ZEN_MODEL,
  route: (model) => {
    switch (model.provider?.npm) {
      case "@ai-sdk/anthropic":
        return Option.some({ protocol: "anthropic", url: ZEN_ANTHROPIC_URL, compatible: true });
      case "@ai-sdk/openai":
        return Option.some({ protocol: "openai-responses", url: ZEN_OPENAI_URL });
      default:
        // The catalog lists image and embedding models too; agents need tool calls.
        return model.tool_call === false
          ? Option.none()
          : Option.some({ protocol: "openai-compat", url: ZEN_OPENAI_URL });
    }
  },
});
