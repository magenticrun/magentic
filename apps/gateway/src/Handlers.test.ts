import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Audit, AuditMemory } from "@magentic/audit";
import { builtin, ConversationStore, PluginHost, Runner } from "@magentic/core";
import { Identity } from "@magentic/identity";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import { AgentDefinition, define, ModelCatalog } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { Api, RPC_PATH } from "@magentic/protocol";
import { fileToolsPlugin, WorkspaceRoot } from "@magentic/tools";
import { DateTime, Effect, FileSystem, Layer, Ref, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http";
import {
  type Rpc,
  RpcClient,
  type RpcGroup,
  RpcSerialization,
  RpcServer,
  RpcTest,
} from "effect/unstable/rpc";
import { ToolCallGuardLive } from "./Guard.ts";
import { RpcHandlers } from "./Handlers.ts";

/** The handlers called directly, no server or serialization between. */
const makeClient = RpcTest.makeClient(Api);

/**
 * The whole way a surface goes: RpcClient, newline-delimited JSON over HTTP,
 * RpcServer, the handlers.
 */
const overTheWire = Effect.gen(function* () {
  const handlers = yield* Effect.context<Rpc.ToHandler<RpcGroup.Rpcs<typeof Api>>>();
  const { handler, dispose } = HttpRouter.toWebHandler(
    RpcServer.layerHttp({ group: Api, path: RPC_PATH, protocol: "http" }).pipe(
      Layer.provide([Layer.succeedContext(handlers), RpcSerialization.layerNdjson]),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  // The server's web handler stands in for the network, so no port is opened.
  const http = HttpClient.make((request, _url, signal) =>
    HttpClientRequest.toWeb(request, { signal }).pipe(
      Effect.flatMap((web) => Effect.promise(() => handler(web))),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.orDie,
    ),
  );
  return yield* RpcClient.make(Api).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://gateway${RPC_PATH}` }).pipe(
        Layer.provide([RpcSerialization.layerNdjson, Layer.succeed(HttpClient.HttpClient, http)]),
      ),
    ),
  );
});

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

const RunnerLayer = Runner.layer.pipe(Layer.provideMerge(ConversationStore.layerMemory));

const ServicesLayer = Layer.mergeAll(RunnerLayer, AdmissionLayer).pipe(
  Layer.provideMerge(HostLayer),
);

const HandlersLayer = RpcHandlers.pipe(Layer.provideMerge(ServicesLayer));

const PlatformLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  ModelCatalog.layerSnapshot,
);

const TestLayer = HandlersLayer.pipe(Layer.provideMerge(PlatformLayer));

layer(TestLayer)("gateway api", (it) => {
  it.effect("answers health", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.health();
    }),
  );

  it.effect("lists registered agents", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const agents = yield* client.listAgents();
      assert.deepStrictEqual(
        agents.map((a) => a.name),
        ["triage"],
      );

      const found = yield* client.getAgent({ name: "triage" });
      assert.deepStrictEqual([...found.tools], ["read_file"]);
      // No model configured, so the first signed-in provider's default.
      assert.strictEqual(found.model, "fake/fake");
    }),
  );

  it.effect("fails for unknown agents", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const error = yield* client.getAgent({ name: "nope" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentNotFound");
    }),
  );

  it.effect("lists plugins with what each contributed", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const plugins = yield* client.listPlugins();
      assert.deepStrictEqual(
        plugins.map((p) => [p.id, p.status, [...p.tools], [...p.agents]]),
        [
          [
            "file-tools",
            "active",
            ["read_file", "write_file", "edit_file", "list_dir", "glob", "grep"],
            [],
          ],
          ["fake", "active", [], []],
          ["triage", "active", [], ["triage"]],
        ],
      );
    }),
  );

  it.effect("streams run events and audits the run", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const events = yield* Stream.runCollect(
        client.run({ agent: "triage", input: "hello there" }),
      );
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "TextDelta", "TokenUsage", "RunFinished"],
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
      const chosen = yield* Stream.runCollect(
        client.run({ agent: "triage", input: "hi", model: "fake/fake" }),
      );
      assert.deepStrictEqual(
        chosen.map((e) => e._tag),
        ["RunStarted", "TextDelta", "TokenUsage", "RunFinished"],
      );

      const unknown = yield* Stream.runCollect(
        client.run({ agent: "triage", input: "hi", model: "fake/nope" }),
      );
      const failure = unknown.at(-1);
      assert.isTrue(failure?._tag === "RunFailed" && failure.message.includes('no model "nope"'));
    }),
  );

  it.effect("keeps conversations to list, replay, and delete", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const events = yield* Stream.runCollect(
        client.run({ agent: "triage", input: "read notes", directory: "/work/here" }),
      );
      const started = events[0];
      const id = started?._tag === "RunStarted" ? started.conversationId : "";

      const listed = yield* client.listConversations({ agent: "triage" });
      const found = listed.find((c) => c.id === id);
      assert.isTrue(found !== undefined && found.title === "read notes" && found.messages === 5);
      assert.strictEqual(found?.usage?.calls, 2);
      const none = yield* client.listConversations({ agent: "nobody" });
      assert.deepStrictEqual(none, []);
      const here = yield* client.listConversations({ directory: "/work/here" });
      assert.isTrue(here.some((c) => c.id === id));
      const elsewhere = yield* client.listConversations({ directory: "/work/there" });
      assert.isFalse(elsewhere.some((c) => c.id === id));

      const transcript = yield* client.transcript({ id });
      assert.deepStrictEqual(
        transcript.map((e) => e._tag),
        ["User", "Tool", "Assistant"],
      );
      const tool = transcript[1];
      assert.isTrue(
        tool?._tag === "Tool" &&
          tool.name === "read_file" &&
          !tool.isFailure &&
          JSON.stringify(tool.result) ===
            JSON.stringify({ path: "notes.txt", content: "remember the milk" }),
      );

      // A rename changes the title and nothing else; a later run keeps it.
      const renamed = yield* client.rename({ id, title: "milk run" });
      assert.strictEqual(renamed.title, "milk run");
      assert.strictEqual(renamed.messages, 5);
      const unknown = yield* client.rename({ id: "nope", title: "x" }).pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "ConversationNotFound");

      // Continuing it carries the history: the fake answers a tool result with "read it".
      const again = yield* Stream.runCollect(
        client.run({ agent: "triage", input: "more", conversationId: id }),
      );
      const continued = yield* client.getConversation({ id });
      assert.strictEqual(continued.messages, 7);
      assert.strictEqual(continued.title, "milk run");

      // Compacting folds the context into a summary; the fake writes back the request's last text.
      const compacted = yield* client.compact({ id });
      assert.strictEqual(compacted.messagesBefore, 7);
      assert.strictEqual(compacted.messagesAfter, 2);
      assert.match(compacted.summary, /^echo: /);
      const folded = yield* client.transcript({ id });
      assert.deepStrictEqual(
        folded.map((e) => e._tag),
        ["User", "Tool", "Assistant", "User", "Assistant", "Summary"],
      );
      // Nothing new since the summary, so a second compaction has nothing to fold.
      const nothing = yield* client.compact({ id }).pipe(Effect.flip);
      assert.strictEqual(nothing._tag, "CompactionFailed");
      const missing = yield* client.compact({ id: "nope" }).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "ConversationNotFound");
      assert.strictEqual(again.at(-1)?._tag, "RunFinished");

      yield* client.removeConversation({ id });
      const gone = yield* client.getConversation({ id }).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "ConversationNotFound");
    }),
  );

  it.effect("audits every tool call the run makes", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const events = yield* Stream.runCollect(client.run({ agent: "triage", input: "read notes" }));
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        [
          "RunStarted",
          "ToolCall",
          "ToolResult",
          "TokenUsage",
          "TextDelta",
          "TokenUsage",
          "RunFinished",
        ],
      );
      const recorded = yield* Ref.get(yield* AuditMemory);
      assert.deepStrictEqual(
        recorded.slice(-2).map((e) => e.action),
        ["run.started", "tool.called"],
      );
    }),
  );

  it.effect("carries streams, dates, bytes, and errors over the wire", () =>
    Effect.gen(function* () {
      const client = yield* overTheWire;
      yield* client.health();
      const events = yield* Stream.runCollect(
        client.run({
          agent: "triage",
          input: "hello there",
          attachments: [{ mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) }],
        }),
      );
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "TextDelta", "TokenUsage", "RunFinished"],
      );
      const started = events[0];
      const id = started?._tag === "RunStarted" ? started.conversationId : "";
      const found = yield* client.getConversation({ id });
      assert.isTrue(DateTime.isDateTime(found.updatedAt));
      assert.strictEqual(found.title, "hello there");

      const error = yield* client.getAgent({ name: "nope" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentNotFound");
      const missing = yield* Stream.runCollect(client.run({ agent: "nobody", input: "x" })).pipe(
        Effect.flip,
      );
      assert.strictEqual(missing._tag, "AgentNotFound");
    }),
  );
});
