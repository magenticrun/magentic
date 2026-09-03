import {
  CatalogModel,
  define,
  LoginError,
  type LoginMethod,
  ModelCatalog,
  ModelInfo,
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
import { reasoningContext } from "../Reasoning.ts";

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
    // One holder of the tokens for every model: refresh tokens rotate, and a
    // second copy refreshing the same one gets the account signed out.
    const auth = yield* CodexAuth.make;

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
          yield* auth.login(tokens);
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
          yield* auth.login(tokens);
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
    const served = Effect.map(catalog.provider("openai"), (found) =>
      Option.match(found, {
        onNone: () => [new CatalogModel({ id: DEFAULT_MODEL, name: DEFAULT_MODEL })],
        onSome: (provider) =>
          Object.values(provider.models)
            .filter(
              (m) => m.id.startsWith("gpt-5") && m.tool_call !== false && m.status !== "deprecated",
            )
            .toSorted((a, b) => a.id.localeCompare(b.id)),
      }),
    );
    // The subscription is not metered by the token, so the API prices do not apply.
    const models = Effect.map(served, (all) =>
      all.map((m) => new ModelInfo({ ...ModelInfo.fromCatalog(m), cost: undefined })),
    );
    const reasoning = (modelId: string, level: string) =>
      Effect.flatMap(served, (all) => {
        const found = all.find((m) => m.id === modelId);
        return found === undefined
          ? Effect.succeedNone
          : reasoningContext("openai-responses", found, level);
      });

    /** One Codex model on the shared auth. */
    const model = (modelId: string) =>
      codexLayer({ model: modelId }).pipe(
        Layer.provide([Layer.succeed(CodexAuth, auth), Layer.succeed(HttpClient.HttpClient, http)]),
      );

    yield* ctx.model.register({
      id,
      name: "OpenAI (ChatGPT subscription)",
      description: "Use a ChatGPT Plus, Pro, Team or Enterprise plan through Codex.",
      methods: [chatgpt, importCli],
      status,
      logout: auth.logout.pipe(Effect.mapError(failed)),
      models,
      defaultModel: DEFAULT_MODEL,
      model: (modelId) =>
        Effect.map(store.load, (loaded) =>
          Option.isSome(loaded) ? Option.some(model(modelId)) : Option.none(),
        ).pipe(Effect.mapError(failed)),
      reasoning,
    });
  }),
});
