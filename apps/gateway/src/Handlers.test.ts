import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Audit, AuditMemory } from "@magentic/audit";
import { builtin, ConversationStore, PluginHost, Runner } from "@magentic/core";
import { Identity } from "@magentic/identity";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import { AgentDefinition, define, ModelCatalog } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { Api } from "@magentic/protocol";
import { fileToolsPlugin, WorkspaceRoot } from "@magentic/tools";
import { Effect, FileSystem, Layer, Ref, Stream } from "effect";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";
import { HttpApiTest } from "effect/unstable/httpapi";
import { ToolCallGuardLive } from "./Guard.ts";
import { AgentsApiHandlersNoDeps, PluginsApiHandlers, SystemApiHandlers } from "./Handlers.ts";

const makeClient = HttpApiTest.groups(Api, ["system", "agents", "plugins"]);

const triage = new AgentDefinition({
  name: "triage",
  description: "Triage issues",
  prompt: "Triage issues.",
  tools: ["read_file"],
});

const triagePlugin = define({
  id: "triage",
  description: "The triage agent.",
  setup: (ctx) =>
    Effect.asVoid(ctx.agent.transform((draft) => Effect.sync(() => draft.set(triage)))),
});

const WorkspaceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-gateway-" });
    yield* fs.writeFileString(`${dir}/notes.txt`, "remember the milk");
    return WorkspaceRoot.layer(dir);
  }),
);

/** Reads notes.txt when asked to, otherwise echoes the last user message. */
const scripted: FakeScript = ({ options }) => {
  const last = options.prompt.content.at(-1);
  if (last?.role === "tool") {
    return [{ type: "text", text: "read it" }];
  }
  const parts = last?.role === "user" ? last.content : [];
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (text === "read notes") {
    return [{ type: "tool-call", id: "call-1", name: "read_file", params: { path: "notes.txt" } }];
  }
  return [{ type: "text", text: `echo: ${text}` }];
};

const AdmissionLayer = Layer.mergeAll(Identity.layerLocal, Policy.layerAllowAll, Audit.layerMemory);

const HostLayer = PluginHost.layer({
  plugins: [builtin(fileToolsPlugin), builtin(fakeProviderPlugin(scripted)), builtin(triagePlugin)],
  paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
}).pipe(Layer.provide([WorkspaceLayer, ToolCallGuardLive.pipe(Layer.provide(AdmissionLayer))]));

const RunnerLayer = Runner.layer.pipe(Layer.provide(ConversationStore.layerMemory));

const ServicesLayer = Layer.mergeAll(RunnerLayer, AdmissionLayer).pipe(
  Layer.provideMerge(HostLayer),
);

const HandlersLayer = Layer.mergeAll(
  SystemApiHandlers,
  Layer.mergeAll(AgentsApiHandlersNoDeps, PluginsApiHandlers).pipe(
    Layer.provideMerge(ServicesLayer),
  ),
);

const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  ModelCatalog.layerSnapshot,
);

/** The handlers on the real platform; the HTTP test services beside them, not under them. */
const TestLayer = Layer.mergeAll(
  HandlersLayer.pipe(Layer.provideMerge(PlatformLayer)),
  HttpServer.layerServices,
);

layer(TestLayer)("gateway api", (it) => {
  it.effect("GET /health", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.health();
    }),
  );

  it.effect("lists registered agents", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const agents = yield* client.agents.list();
      assert.deepStrictEqual(
        agents.map((a) => a.name),
        ["triage"],
      );

      const found = yield* client.agents.get({ params: { name: "triage" } });
      assert.deepStrictEqual([...found.tools], ["read_file"]);
      // No model configured, so the first signed-in provider's default.
      assert.strictEqual(found.model, "fake/fake");
    }),
  );

  it.effect("returns 404 for unknown agents", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const error = yield* client.agents.get({ params: { name: "nope" } }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentNotFound");
    }),
  );

  it.effect("lists plugins with what each contributed", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const plugins = yield* client.plugins.list();
      assert.deepStrictEqual(
        plugins.map((p) => [p.id, p.status, [...p.tools], [...p.agents]]),
        [
          ["file-tools", "active", ["read_file", "write_file"], []],
          ["fake", "active", [], []],
          ["triage", "active", [], ["triage"]],
        ],
      );
    }),
  );

  it.effect("streams run events over SSE and audits the run", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const stream = yield* client.agents.run({
        params: { name: "triage" },
        payload: { input: "hello there" },
      });
      const events = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "TextDelta", "RunFinished"],
      );
      const delta = events[1];
      assert.isTrue(delta?._tag === "TextDelta" && delta.text === "echo: hello there");

      const recorded = yield* Ref.get(yield* AuditMemory);
      assert.deepStrictEqual(
        recorded.map((e) => e.action),
        ["run.started"],
      );
    }),
  );

  it.effect("runs on the model the request names", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const chosen = yield* client.agents
        .run({ params: { name: "triage" }, payload: { input: "hi", model: "fake/fake" } })
        .pipe(Effect.flatMap(Stream.runCollect));
      assert.deepStrictEqual(
        chosen.map((e) => e._tag),
        ["RunStarted", "TextDelta", "RunFinished"],
      );

      const unknown = yield* client.agents
        .run({ params: { name: "triage" }, payload: { input: "hi", model: "fake/nope" } })
        .pipe(Effect.flatMap(Stream.runCollect));
      const failure = unknown.at(-1);
      assert.isTrue(failure?._tag === "RunFailed" && failure.message.includes('no model "nope"'));
    }),
  );

  it.effect("audits every tool call the run makes", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const stream = yield* client.agents.run({
        params: { name: "triage" },
        payload: { input: "read notes" },
      });
      const events = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "ToolCall", "ToolResult", "TextDelta", "RunFinished"],
      );
      const recorded = yield* Ref.get(yield* AuditMemory);
      assert.deepStrictEqual(
        recorded.slice(-2).map((e) => e.action),
        ["run.started", "tool.called"],
      );
    }),
  );
});
