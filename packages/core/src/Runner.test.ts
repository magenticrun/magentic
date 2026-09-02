import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import { AgentDefinition, ModelCatalog } from "@magentic/plugin";
import { Principal } from "@magentic/protocol";
import { fileToolsPlugin, WorkspaceRoot } from "@magentic/tools";
import { Effect, FileSystem, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ConversationStore } from "./ConversationStore.ts";
import { builtin, PluginHost } from "./plugin/PluginHost.ts";
import { ToolCallGuard } from "./plugin/ToolRegistry.ts";
import { Runner } from "./Runner.ts";

const reader = new AgentDefinition({
  name: "reader",
  description: "Reads files",
  prompt: "You read files.",
  tools: ["read_file"],
});

const alice = new Principal({ id: "alice", displayName: "Alice", groups: [], provider: "local" });

/** Call 0 reads a file, call 1 answers, later calls answer with the history size. */
const script: FakeScript = ({ index, options }) => {
  const toolNames = options.tools.map((tool) => tool.name);
  if (index === 0) {
    return [
      {
        type: "tool-call",
        id: "call-1",
        name: "read_file",
        params: { path: "hello.txt" },
      },
    ];
  }
  if (index === 1) {
    return [{ type: "text", text: `tools=${toolNames.join(",")}` }];
  }
  const files = options.prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );
  return [
    {
      type: "text",
      text: `messages=${options.prompt.content.length} files=${files.map((f) => f.mediaType).join(",")}`,
    },
  ];
};

const WorkspaceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-runner-" });
    yield* fs.writeFileString(`${dir}/hello.txt`, "hi");
    return WorkspaceRoot.layer(dir);
  }),
);

const HostLayer = PluginHost.layer({
  plugins: [builtin(fileToolsPlugin), builtin(fakeProviderPlugin(script))],
  paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
}).pipe(Layer.provide([WorkspaceLayer, ToolCallGuard.layerAllowAll]));

/** Conversations on disk in a scratch directory, so the file store is what the runner exercises. */
const StoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-conversations-" });
    return ConversationStore.layerFile(dir);
  }),
);

const TestLayer = Runner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HostLayer, StoreLayer)),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(TestLayer)("Runner", (it) => {
  it.effect("loops through a tool call and continues the conversation", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      const events = yield* Stream.runCollect(
        runner.run({
          agent: reader,
          principal: alice,
          input: "what does hello.txt say?",
          attachments: [
            {
              mediaType: "image/png",
              data: new Uint8Array([137, 80, 78, 71]),
              fileName: "shot.png",
            },
          ],
          conversationId: Option.none(),
          model: Option.none(),
          directory: Option.some("/work/here"),
        }),
      );
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
      const call = events[1];
      const result = events[2];
      const text = events[4];
      assert.isTrue(call?._tag === "ToolCall" && call.name === "read_file");
      assert.isTrue(
        result?._tag === "ToolResult" &&
          !result.isFailure &&
          JSON.stringify(result.result) === JSON.stringify({ path: "hello.txt", content: "hi" }),
      );
      // The agent lists only read_file, so that is all the model was offered.
      assert.isTrue(text?._tag === "TextDelta" && text.text === "tools=read_file");
      // Usage arrives once per model call, with the estimate over the history so far.
      const usage = events[5];
      assert.isTrue(usage?._tag === "TokenUsage" && usage.inputTokens === 10);
      if (usage?._tag === "TokenUsage") {
        assert.strictEqual(usage.breakdown.toolCount, 1);
        assert.isAbove(usage.breakdown.system, 0);
        assert.isAbove(usage.breakdown.tools, 0);
        assert.isAbove(usage.breakdown.toolCalls, 0);
        // system, user, assistant (tool call), tool (result), assistant (text)
        assert.strictEqual(usage.breakdown.messages, 5);
      }

      const started = events[0];
      const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
      assert.notStrictEqual(conversationId, "");
      const second = yield* Stream.runCollect(
        runner.run({
          agent: reader,
          principal: alice,
          input: "and again?",
          attachments: [],
          conversationId: Option.some(conversationId),
          model: Option.none(),
          directory: Option.some("/work/elsewhere"),
        }),
      );
      const reply = second.find((e) => e._tag === "TextDelta");
      // system + user + assistant(tool call) + tool result + assistant + user = 6 before this turn,
      // and the image sent with the first input is still in the history.
      assert.strictEqual(
        reply?._tag === "TextDelta" ? reply.text : reply,
        "messages=6 files=image/png",
      );

      // What the conversation is, kept on disk beside its history.
      const store = yield* ConversationStore;
      const saved = yield* store.get(conversationId);
      assert.isTrue(Option.isSome(saved));
      if (Option.isSome(saved)) {
        assert.strictEqual(saved.value.title, "what does hello.txt say?");
        assert.strictEqual(saved.value.agent, "reader");
        assert.strictEqual(saved.value.principal, "alice");
        assert.strictEqual(saved.value.model, "fake/fake");
        // The directory is where it started; continuing from elsewhere does not move it.
        assert.strictEqual(saved.value.directory, "/work/here");
        assert.strictEqual(saved.value.messages, 7);
        assert.strictEqual(saved.value.usage?.calls, 3);
        assert.strictEqual(saved.value.usage?.totalInputTokens, 30);
      }
      const listed = yield* store.list;
      assert.deepStrictEqual(
        listed.map((c) => c.id),
        [conversationId],
      );
    }),
  );
});
