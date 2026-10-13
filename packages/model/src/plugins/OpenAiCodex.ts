import {
  CatalogModel,
  define,
  LoginError,
  type LoginMethod,
  ModelCatalog,
  ModelInfo,
  Screen,
} from "@magentic/plugin";
import { Duration, Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient } from "effect/http";
import { CodexAuth } from "../codex/CodexAuth.ts";
import { CodexAuthStore, readCodexCliAuth } from "../codex/CodexAuthStore.ts";
import { codexCliAuthFile } from "../codex/CodexConfig.ts";
import { DEFAULT_MODEL, layer as codexLayer } from "../codex/CodexLanguageModel.ts";
import { deviceLogin } from "../codex/CodexLogin.ts";
import { fetchCodexModels } from "../codex/CodexModels.ts";
import { type CodexTokens, planTypeOf } from "../codex/CodexTokens.ts";
import { isOpenAiEffort, reasoningContext } from "../Reasoning.ts";

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

    const openai = Effect.map(catalog.provider("openai"), (found) =>
      Option.match(found, {
        onNone: (): Readonly<Record<string, CatalogModel>> => ({}),
        onSome: (provider) => provider.models,
      }),
    );

    /** A guess from models.dev, for when the backend cannot be asked: signed out, or offline. */
    const guessed = Effect.map(openai, (models) => {
      const all = Object.values(models).filter(
        (m) => m.id.startsWith("gpt-5") && m.tool_call !== false && m.status !== "deprecated",
      );
      return all.length === 0
        ? [new CatalogModel({ id: DEFAULT_MODEL, name: DEFAULT_MODEL })]
        : all.toSorted((a, b) => a.id.localeCompare(b.id));
    });

    /**
     * The backend's list, in the catalog's shape. The backend knows the plan's
     * models, their window and their efforts; models.dev adds the output limit
     * and whether they take attachments.
     */
    const fetched = Effect.gen(function* () {
      const known = yield* openai;
      const models = yield* fetchCodexModels(auth).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      return models.map((served) => {
        const listed = Object.hasOwn(known, served.slug) ? known[served.slug] : undefined;
        // The backend also lists `ultra`, which the OpenAI client refuses to send.
        const efforts = (served.supported_reasoning_levels ?? [])
          .map((level) => level.effort)
          .filter(isOpenAiEffort);
        return new CatalogModel({
          id: served.slug,
          name: served.display_name,
          reasoning: efforts.length > 0,
          tool_call: true,
          attachment: listed?.attachment,
          limit: {
            context: served.context_window ?? listed?.limit?.context ?? 0,
            output: listed?.limit?.output,
          },
          reasoning_options: [{ type: "effort", values: efforts }],
        });
      });
    });

    // Codex keeps its copy of the list for five minutes; a login or logout drops it at once.
    const [served, forget] = yield* Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        const loaded = yield* Effect.option(store.load);
        if (Option.isNone(Option.flatten(loaded))) {
          return yield* guessed;
        }
        return yield* fetched.pipe(
          Effect.catch((error) =>
            Effect.logWarning(`codex models: ${error.message}; listing models.dev's instead`).pipe(
              Effect.andThen(guessed),
            ),
          ),
        );
      }),
      Duration.minutes(5),
    );

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
          yield* forget;
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
          yield* forget;
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
      logout: auth.logout.pipe(Effect.andThen(forget), Effect.mapError(failed)),
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
