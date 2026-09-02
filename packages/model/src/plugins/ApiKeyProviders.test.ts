import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import {
  ModelCatalog,
  type ModelProviderRegistration,
  type Plugin,
  type PluginContext,
} from "@magentic/plugin";
import { Context, Effect, Layer, Option, Redacted, Ref, type Schema, Scope, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import { ApiKeyStore } from "../ApiKeys.ts";
import { fakeHttp } from "../codex/testing.ts";
import {
  DEFAULT_ZAI_MODEL,
  DEFAULT_ZEN_MODEL,
  ZAI_ANTHROPIC_URL,
  ZEN_ANTHROPIC_URL,
  ZEN_OPENAI_URL,
} from "../ModelProvider.ts";
import { opencodeZenPlugin, zaiPlugin } from "./ApiKeyProviders.ts";

/**
 * Replies the way a compatible endpoint does: Anthropic's shape, but without
 * the cache and routing usage keys Anthropic itself always includes.
 */
const reply = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: DEFAULT_ZAI_MODEL,
  content: [{ type: "text", text: "Friday." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
});

const sse = (events: ReadonlyArray<Schema.JsonObject>) =>
  events
    .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

const streamedReply = sse([
  {
    type: "message_start",
    message: {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: DEFAULT_ZAI_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fri" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "day." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  },
  { type: "message_stop" },
]);

const unused = Effect.die("not used by an API key plugin");

type ApiKeyPlugin = Plugin<ApiKeyStore | HttpClient.HttpClient | ModelCatalog>;

/** Runs a plugin's setup and hands back the one provider it registered. */
const registered = Effect.fn("registered")(function* (plugin: ApiKeyPlugin) {
  const seen = yield* Ref.make(Option.none<ModelProviderRegistration>());
  const ctx: PluginContext = {
    options: {},
    paths: { config: "/nonexistent/magentic", workspace: "/nonexistent" },
    tool: { registerToolkit: () => unused, hook: () => unused },
    model: {
      register: (provider) =>
        Ref.set(seen, Option.some(provider)).pipe(Effect.as({ dispose: Effect.void })),
    },
    agent: { transform: () => unused, rebuild: Effect.void },
    event: { subscribe: () => Stream.empty },
  };
  yield* plugin.setup(ctx);
  return Option.getOrThrow(yield* Ref.get(seen));
});

/** The provider's LanguageModel for `id`, built into the test's scope. */
const modelOf = Effect.fn("modelOf")(function* (provider: ModelProviderRegistration, id: string) {
  const modelLayer = Option.getOrThrow(yield* provider.model(id));
  const scope = yield* Scope.Scope;
  const context = yield* Layer.build(modelLayer).pipe(Effect.provideService(Scope.Scope, scope));
  return Context.get(context, LanguageModel.LanguageModel);
});

const TestLayer = Layer.mergeAll(
  ApiKeyStore.layerMemory(
    new Map([
      ["zai", Redacted.make("zai-secret-key-1234")],
      ["opencode-zen", Redacted.make("zen-secret-key-5678")],
    ]),
  ),
  ModelCatalog.layerSnapshot,
  BunServices.layer,
);

layer(TestLayer)("zaiPlugin", (it) => {
  it.effect("reports the stored key and lists every GLM model from the catalog", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([]);
      const provider = yield* registered(zaiPlugin).pipe(Effect.provide(http.layer));
      assert.strictEqual(provider.id, "zai");
      assert.strictEqual(provider.name, "Z.AI (API key)");
      assert.deepStrictEqual(yield* provider.status, Option.some("API key zai…1234"));
      const models = yield* provider.models;
      assert.include(
        models.map((m) => m.id),
        DEFAULT_ZAI_MODEL,
      );
      assert.isTrue(models.every((m) => m.id.startsWith("glm-")));
    }),
  );

  it.effect("sends the key and the chosen model to Z.AI's Anthropic endpoint", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([{ status: 200, body: reply }]);
      const provider = yield* registered(zaiPlugin).pipe(Effect.provide(http.layer));
      const model = yield* modelOf(provider, "glm-5.1");

      const response = yield* model.generateText({ prompt: "What day is it?" });
      assert.strictEqual(response.text, "Friday.");

      const [request] = yield* http.requests;
      assert.strictEqual(request?.url, `${ZAI_ANTHROPIC_URL}/v1/messages?beta=true`);
      assert.strictEqual(request?.headers["x-api-key"], "zai-secret-key-1234");
      assert.strictEqual(JSON.parse(request?.body ?? "{}").model, "glm-5.1");
    }),
  );

  it.effect("decodes a streamed reply that omits Anthropic's cache usage keys", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([
        { status: 200, body: streamedReply, contentType: "text/event-stream" },
      ]);
      const provider = yield* registered(zaiPlugin).pipe(Effect.provide(http.layer));
      const model = yield* modelOf(provider, DEFAULT_ZAI_MODEL);

      const parts = yield* model.streamText({ prompt: "What day is it?" }).pipe(Stream.runCollect);
      const text = parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      assert.strictEqual(text, "Friday.");
    }),
  );
});

layer(TestLayer)("opencodeZenPlugin", (it) => {
  it.effect("lists what Zen serves over Anthropic Messages or OpenAI Responses", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([]);
      const provider = yield* registered(opencodeZenPlugin).pipe(Effect.provide(http.layer));
      const ids = (yield* provider.models).map((m) => m.id);
      assert.include(ids, DEFAULT_ZEN_MODEL);
      assert.include(ids, "gpt-5.5");
      // Gemini needs Google's protocol; Kimi is chat-completions only. Neither has a client.
      assert.isFalse(ids.some((id) => id.startsWith("gemini-") || id.startsWith("kimi-")));
    }),
  );

  it.effect("sends Claude requests to Zen's Anthropic route", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([{ status: 200, body: reply }]);
      const provider = yield* registered(opencodeZenPlugin).pipe(Effect.provide(http.layer));
      const model = yield* modelOf(provider, DEFAULT_ZEN_MODEL);

      const response = yield* model.generateText({ prompt: "What day is it?" });
      assert.strictEqual(response.text, "Friday.");

      const [request] = yield* http.requests;
      assert.strictEqual(request?.url, `${ZEN_ANTHROPIC_URL}/v1/messages?beta=true`);
      assert.strictEqual(request?.headers["x-api-key"], "zen-secret-key-5678");
      assert.strictEqual(JSON.parse(request?.body ?? "{}").model, DEFAULT_ZEN_MODEL);
    }),
  );

  it.effect("sends GPT requests to Zen's OpenAI Responses route", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([{ status: 500, body: "{}" }]);
      const provider = yield* registered(opencodeZenPlugin).pipe(Effect.provide(http.layer));
      const model = yield* modelOf(provider, "gpt-5.5");

      // The reply is not a Responses object; only the request matters here.
      yield* Effect.result(model.generateText({ prompt: "What day is it?" }));

      const [request] = yield* http.requests;
      assert.strictEqual(request?.url, `${ZEN_OPENAI_URL}/responses`);
      assert.strictEqual(request?.headers["authorization"], "Bearer zen-secret-key-5678");
      assert.strictEqual(JSON.parse(request?.body ?? "{}").model, "gpt-5.5");
    }),
  );
});
