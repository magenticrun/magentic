import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { builtin, ModelRegistry, PluginHost, ToolCallGuard } from "@magentic/core";
import { ApiKeyStore, Codex, modelPlugins } from "@magentic/model";
import {
  type Choice,
  LoginCancelled,
  type LoginUi,
  ModelCatalog,
  type Screen,
} from "@magentic/plugin";
import { ConfigProvider, Effect, Layer, Option, Redacted, Ref, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { runLogin } from "./Login.ts";

/** A surface that answers from a script and records every screen it was shown. */
const scriptedUi = Effect.fn("scriptedUi")(function* (script: {
  readonly pick: (title: string, choices: ReadonlyArray<Choice>) => Choice | undefined;
  readonly secret?: string;
}) {
  const shown = yield* Ref.make<ReadonlyArray<Screen>>([]);
  const record = (screen: Screen) => Ref.update(shown, (all) => [...all, screen]);
  const ui: LoginUi = {
    choose: (title, choices) => {
      const choice = script.pick(title, choices);
      return choice === undefined ? Effect.fail(new LoginCancelled()) : Effect.succeed(choice);
    },
    secret: () =>
      script.secret === undefined
        ? Effect.fail(new LoginCancelled())
        : Effect.succeed(Redacted.make(script.secret)),
    show: record,
    finish: record,
  };
  return { ui, shown: Ref.get(shown) };
});

const Stores = Layer.mergeAll(Codex.CodexAuthStore.layerMemory(), ApiKeyStore.layerMemory());

const TestLayer = PluginHost.layer({
  plugins: modelPlugins.map(builtin),
  paths: { config: "/nonexistent/magentic", workspace: "/nonexistent" },
}).pipe(
  Layer.provideMerge(Stores),
  Layer.provide(ToolCallGuard.layerAllowAll),
  Layer.provideMerge(
    Layer.mergeAll(FetchHttpClient.layer, BunServices.layer, ModelCatalog.layerSnapshot),
  ),
);

const providers = Effect.flatMap(ModelRegistry, (registry) => registry.list);

layer(TestLayer)("auth login", (it) => {
  it.effect("walks provider list to a stored API key", () =>
    Effect.gen(function* () {
      const titles: Array<string> = [];
      const { ui, shown } = yield* scriptedUi({
        pick: (title, choices) => {
          titles.push(title);
          return choices.find((c) => c.id === "anthropic");
        },
        secret: "sk-ant-secret-1234",
      });
      const result = yield* runLogin({
        ui,
        providers: yield* providers,
        provider: Option.none(),
        method: Option.none(),
      });
      assert.strictEqual(result.provider.id, "anthropic");
      assert.strictEqual(result.method.id, "api-key");
      assert.strictEqual(result.summary, "API key sk-…1234");
      // One provider was one method only, so no method picker.
      assert.deepStrictEqual(titles, ["Sign in to a provider"]);
      const store = yield* ApiKeyStore;
      const stored = yield* store.get("anthropic");
      assert.deepStrictEqual(Option.map(stored, Redacted.value), Option.some("sk-ant-secret-1234"));
      const screens = yield* shown;
      assert.deepStrictEqual(screens.at(-1)?._tag, "Done");
    }),
  );

  it.effect("shows the signed-in state in the provider list", () =>
    Effect.gen(function* () {
      const store = yield* ApiKeyStore;
      yield* store.set("openai", Redacted.make("sk-openai-secret-5678"));
      let seen: ReadonlyArray<Choice> = [];
      const { ui } = yield* scriptedUi({
        pick: (_, choices) => {
          seen = choices;
          return undefined;
        },
      });
      const outcome = yield* Effect.result(
        runLogin({
          ui,
          providers: yield* providers,
          provider: Option.none(),
          method: Option.none(),
        }),
      );
      assert.isTrue(Result.isFailure(outcome));
      const openai = seen.find((c) => c.id === "openai");
      assert.strictEqual(openai?.description, "Signed in: API key sk-…5678");
      const codex = seen.find((c) => c.id === "openai-codex");
      assert.isTrue(codex?.description.startsWith("Use a ChatGPT"));
    }),
  );

  it.effect("asks which method when the provider has several, and honours --provider", () =>
    Effect.gen(function* () {
      const titles: Array<string> = [];
      const { ui } = yield* scriptedUi({
        pick: (title, choices) => {
          titles.push(title);
          return choices.find((c) => c.id === "import");
        },
      });
      // Codex has two methods, so the method picker is shown even with --provider.
      // The import then fails offline because CODEX_HOME is empty; that is fine here.
      const outcome = yield* runLogin({
        ui,
        providers: yield* providers,
        provider: Option.some("openai-codex"),
        method: Option.none(),
      }).pipe(
        Effect.result,
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: "/nonexistent/codex" })),
        ),
      );
      assert.isTrue(Result.isFailure(outcome));
      assert.deepStrictEqual(titles, [
        "OpenAI (ChatGPT subscription): how do you want to sign in?",
      ]);

      const unknown = yield* Effect.result(
        runLogin({
          ui,
          providers: yield* providers,
          provider: Option.some("nope"),
          method: Option.none(),
        }),
      );
      assert.isTrue(Result.isFailure(unknown) && unknown.failure._tag === "NoSuchProvider");
    }),
  );

  it.effect("reports failures on the outcome screen and still fails", () =>
    Effect.gen(function* () {
      const { ui, shown } = yield* scriptedUi({ pick: (_, choices) => choices[0] });
      // No Codex CLI login to import: CODEX_HOME points at an empty directory.
      const outcome = yield* runLogin({
        ui,
        providers: yield* providers,
        provider: Option.some("openai-codex"),
        method: Option.some("import"),
      }).pipe(
        Effect.result,
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: "/nonexistent/codex" })),
        ),
      );
      assert.isTrue(Result.isFailure(outcome) && outcome.failure._tag === "LoginError");
      const screens = yield* shown;
      assert.strictEqual(screens.at(-1)?._tag, "Failed");
    }),
  );
});
