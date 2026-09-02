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
  return [{ type: "text", text: `messages=${options.prompt.content.length}` }];
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
  paths: { config: "/nonexistent", workspace: "/nonexistent" },
}).pipe(Layer.provide([WorkspaceLayer, ToolCallGuard.layerAllowAll]));

const TestLayer = Runner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HostLayer, ConversationStore.layerMemory)),
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
          conversationId: Option.none(),
        }),
      );
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "ToolCall", "ToolResult", "TextDelta", "RunFinished"],
      );
      const call = events[1];
      const result = events[2];
      const text = events[3];
      assert.isTrue(call?._tag === "ToolCall" && call.name === "read_file");
      assert.isTrue(
        result?._tag === "ToolResult" &&
          !result.isFailure &&
          JSON.stringify(result.result) === JSON.stringify({ path: "hello.txt", content: "hi" }),
      );
      // The agent lists only read_file, so that is all the model was offered.
      assert.isTrue(text?._tag === "TextDelta" && text.text === "tools=read_file");

      const started = events[0];
      const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
      assert.notStrictEqual(conversationId, "");
      const second = yield* Stream.runCollect(
        runner.run({
          agent: reader,
          principal: alice,
          input: "and again?",
          conversationId: Option.some(conversationId),
        }),
      );
      const reply = second.find((e) => e._tag === "TextDelta");
      // system + user + assistant(tool call) + tool result + assistant + user = 6 before this turn
      assert.isTrue(reply?._tag === "TextDelta" && reply.text === "messages=6");
    }),
  );
});
