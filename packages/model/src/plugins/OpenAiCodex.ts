import {
  define,
  LoginError,
  type LoginMethod,
  ModelCatalog,
  ModelInfo,
  ModelProviderError,
  Screen,
} from "@magentic/plugin";
import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient } from "effect/unstable/http";
import { CodexAuth } from "../codex/CodexAuth.ts";
import { CodexAuthStore, readCodexCliAuth } from "../codex/CodexAuthStore.ts";
import { codexCliAuthFile } from "../codex/CodexConfig.ts";
import { DEFAULT_MODEL, layer as codexLayer } from "../codex/CodexLanguageModel.ts";
import { deviceLogin } from "../codex/CodexLogin.ts";
import { type CodexTokens, planTypeOf } from "../codex/CodexTokens.ts";

const id = "openai-codex";

const describe = (error: { readonly message: string; readonly reason?: string }) =>
  error.reason === undefined ? error.message : `${error.reason}: ${error.message}`;

const failed = (error: { readonly message: string; readonly reason?: string }) =>
  new LoginError({ provider: id, message: describe(error) });

const summary = Effect.fn("openaiCodex.summary")(function* (tokens: CodexTokens) {
  const plan = yield* planTypeOf(tokens.idToken);
  const suffix = Option.match(plan, { onNone: () => "", onSome: (p) => ` (${p} plan)` });
  return `ChatGPT account ${tokens.accountId}${suffix}`;
});

/** The ChatGPT subscription through Codex: device-code sign-in, or a copy of the Codex CLI's login. */
export const openaiCodexPlugin = define<
  CodexAuthStore | FileSystem.FileSystem | HttpClient.HttpClient | ModelCatalog
>({
  id,
  description: "OpenAI through a ChatGPT subscription.",
  setup: Effect.fn("openaiCodexPlugin.setup")(function* (ctx) {
    const store = yield* CodexAuthStore;
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const catalog = yield* ModelCatalog;

    const chatgpt: LoginMethod = {
      id: "chatgpt",
      name: "Sign in with ChatGPT",
      description: "Open a link on any device and type a short code. Works over SSH.",
      run: Effect.fn("openaiCodex.chatgpt")(
        function* (ui) {
          yield* ui.show(Screen.Busy({ message: "Asking OpenAI for a device code…" }));
          const tokens = yield* deviceLogin({
            onPrompt: (prompt) =>
              ui.show(Screen.DeviceCode({ url: prompt.verificationUrl, code: prompt.userCode })),
          });
          yield* ui.show(Screen.Busy({ message: "Saving the login…" }));
          yield* store.save(tokens);
          return yield* summary(tokens);
        },
        Effect.mapError(failed),
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    };

    const importCli: LoginMethod = {
      id: "import",
      name: "Copy the Codex CLI login",
      description: "Reuse ~/.codex/auth.json without signing in again.",
      run: Effect.fn("openaiCodex.import")(
        function* (ui) {
          const file = yield* codexCliAuthFile;
          yield* ui.show(Screen.Busy({ message: `Reading ${file}…` }));
          const tokens = yield* readCodexCliAuth(file);
          yield* store.save(tokens);
          const text = yield* summary(tokens);
          return `${text}, copied from ${file}. The two logins refresh independently from now on.`;
        },
        Effect.mapError(failed),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    };

    const status = Effect.gen(function* () {
      const loaded = yield* store.load;
      if (Option.isNone(loaded)) {
        return Option.none();
      }
      return Option.some(yield* summary(loaded.value));
    }).pipe(Effect.mapError(failed));

    /** The GPT-5 family is what the ChatGPT backend serves; the catalog keeps the list current. */
    const models = Effect.map(catalog.provider("openai"), (found) =>
      Option.match(found, {
        onNone: () => [ModelInfo.fromCatalog({ id: DEFAULT_MODEL, name: DEFAULT_MODEL })],
        onSome: (provider) =>
          Object.values(provider.models)
            .filter(
              (m) => m.id.startsWith("gpt-5") && m.tool_call !== false && m.status !== "deprecated",
            )
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map(ModelInfo.fromCatalog),
      }),
    );

    /** One Codex model with its own auth, errors in the provider's words. */
    const model = (modelId: string) =>
      Layer.effectContext(
        Layer.build(codexLayer({ model: modelId }).pipe(Layer.provide(CodexAuth.layer))).pipe(
          Effect.mapError(
            (error) => new ModelProviderError({ provider: id, message: describe(error) }),
          ),
          Effect.provideService(CodexAuthStore, store),
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      );

    yield* ctx.model.register({
      id,
      name: "OpenAI (ChatGPT subscription)",
      description: "Use a ChatGPT Plus, Pro, Team or Enterprise plan through Codex.",
      methods: [chatgpt, importCli],
      status,
      logout: store.clear.pipe(Effect.mapError(failed)),
      models,
      defaultModel: DEFAULT_MODEL,
      model: (modelId) =>
        Effect.map(store.load, (loaded) =>
          Option.isSome(loaded) ? Option.some(model(modelId)) : Option.none(),
        ).pipe(Effect.mapError(failed)),
    });
  }),
});
