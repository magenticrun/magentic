import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import { AgentDefinition, ModelCatalog } from "@magentic/plugin";
import { Principal } from "@magentic/protocol";
import { fileToolsPlugin, WorkspaceRoot } from "@magentic/tools";
import { Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AiError } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { ConversationStore } from "./ConversationStore.ts";
import { builtin, PluginHost } from "./plugin/PluginHost.ts";
import { ToolCallGuard } from "./plugin/ToolRegistry.ts";
import { Runner } from "./Runner.ts";
import { transcriptFromJson } from "./Transcript.ts";

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

      // On request the whole context folds into one summary the model wrote; the
      // fake's summary is its usual readout of what it was sent: two messages,
      // the summariser's own system prompt and the request.
      const compacted = yield* runner.compact({
        agent: reader,
        conversationId,
        model: Option.none(),
      });
      assert.deepStrictEqual(compacted, {
        _tag: "Compacted",
        summary: "messages=2 files=",
        messagesBefore: 7,
        messagesAfter: 2,
      });
      const after = yield* store.get(conversationId);
      assert.strictEqual(Option.isSome(after) ? after.value.messages : 0, 2);
      // The stored history still holds everything: what was said, then the summary.
      const history = yield* store.history(conversationId);
      const transcript = yield* transcriptFromJson(Option.getOrElse(history, () => ""));
      assert.deepStrictEqual(
        transcript.map((e) => e._tag),
        ["User", "Tool", "Assistant", "User", "Assistant", "Summary"],
      );
      const summary = transcript.at(-1);
      assert.strictEqual(summary?._tag === "Summary" ? summary.text : summary, "messages=2 files=");
      // The next run continues from the summary alone: system, summary, and its input.
      const third = yield* Stream.runCollect(
        runner.run({
          agent: reader,
          principal: alice,
          input: "still there?",
          attachments: [],
          conversationId: Option.some(conversationId),
          model: Option.none(),
          directory: Option.none(),
        }),
      );
      const continued = third.find((e) => e._tag === "TextDelta");
      assert.strictEqual(
        continued?._tag === "TextDelta" ? continued.text : continued,
        "messages=3 files=",
      );
      assert.strictEqual(
        (yield* transcriptFromJson(
          Option.getOrElse(yield* store.history(conversationId), () => ""),
        )).length,
        8,
      );
    }),
  );
});

/** Every call answers with the history size; the model claims a window the first call fills. */
const tight: FakeScript = ({ options }) => [
  { type: "text", text: `messages=${options.prompt.content.length}` },
];

const TightLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.layer({
        plugins: [builtin(fakeProviderPlugin(tight, { context: 12, output: 4 }))],
        paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
      }).pipe(Layer.provide(ToolCallGuard.layerAllowAll)),
      ConversationStore.layerMemory,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

const talker = new AgentDefinition({
  name: "talker",
  description: "Talks",
  prompt: "You talk.",
  tools: [],
});

layer(TightLayer)("Runner auto compaction", (it) => {
  it.effect("compacts when a call reaches the window and continues from the summary", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      // The fake counts 10 input and 1 output token a call; usable room is 12 - 4 = 8.
      const events = yield* Stream.runCollect(
        runner.run({
          agent: talker,
          principal: alice,
          input: "hello",
          attachments: [],
          conversationId: Option.none(),
          model: Option.none(),
          directory: Option.none(),
        }),
      );
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["RunStarted", "TextDelta", "TokenUsage", "CompactionStarted", "Compacted", "RunFinished"],
      );
      const compacted = events[4];
      // system, user, assistant fold into system and summary; the summary is the fake's readout.
      assert.deepStrictEqual(compacted, {
        _tag: "Compacted",
        summary: "messages=2",
        messagesBefore: 3,
        messagesAfter: 2,
      });
      const started = events[0];
      const id = started?._tag === "RunStarted" ? started.conversationId : "";
      const second = yield* Stream.runCollect(
        runner.run({
          agent: talker,
          principal: alice,
          input: "again",
          attachments: [],
          conversationId: Option.some(id),
          model: Option.none(),
          directory: Option.none(),
        }),
      );
      const reply = second.find((e) => e._tag === "TextDelta");
      assert.strictEqual(reply?._tag === "TextDelta" ? reply.text : reply, "messages=3");
      // Compacted again at the end of this run, carrying the earlier summary into the new one.
      const again = second.find((e) => e._tag === "Compacted");
      assert.strictEqual(again?._tag === "Compacted" ? again.messagesBefore : 0, 4);
      const store = yield* ConversationStore;
      const transcript = yield* transcriptFromJson(
        Option.getOrElse(yield* store.history(id), () => ""),
      );
      assert.deepStrictEqual(
        transcript.map((e) => e._tag),
        ["User", "Assistant", "Summary", "User", "Assistant", "Summary"],
      );
    }),
  );
});

const providerDown = new AiError.AiError({
  module: "Fake",
  method: "streamText",
  reason: new AiError.InternalProviderError({ description: "Internal network failure" }),
});
const badKey = new AiError.AiError({
  module: "Fake",
  method: "streamText",
  reason: new AiError.AuthenticationError({ kind: "InvalidKey", description: "bad key" }),
});

/** The first call fails as a provider does when it is down; the second answers; the third is refused. */
const flaky: FakeScript = ({ index, options }) => {
  if (index === 0) {
    return providerDown;
  }
  if (index === 1) {
    return [{ type: "text", text: `messages=${options.prompt.content.length}` }];
  }
  return badKey;
};

const FlakyLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.layer({
        plugins: [builtin(fakeProviderPlugin(flaky))],
        paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
      }).pipe(Layer.provide(ToolCallGuard.layerAllowAll)),
      ConversationStore.layerMemory,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(FlakyLayer)("Runner retries", (it) => {
  it.effect(
    "tries a failed call again from the same history, and gives up on one that would fail again",
    () =>
      Effect.gen(function* () {
        const runner = yield* Runner;
        const collecting = yield* Effect.forkChild(
          Stream.runCollect(
            runner.run({
              agent: talker,
              principal: alice,
              input: "hello",
              attachments: [],
              conversationId: Option.none(),
              model: Option.none(),
              directory: Option.none(),
            }),
          ),
        );
        // The first retry waits about two seconds on the test clock.
        yield* TestClock.adjust("1 minute");
        const events = yield* Fiber.join(collecting);
        assert.deepStrictEqual(
          events.map((e) => e._tag),
          ["RunStarted", "Retrying", "TextDelta", "TokenUsage", "RunFinished"],
        );
        const retrying = events[1];
        assert.isTrue(
          retrying?._tag === "Retrying" &&
            retrying.attempt === 1 &&
            retrying.message.includes("Internal network failure") &&
            retrying.delayMs >= 1600 &&
            retrying.delayMs <= 2400,
        );
        // The failed call's prompt was not left in the history: system and user only.
        const reply = events[2];
        assert.isTrue(reply?._tag === "TextDelta" && reply.text === "messages=2");

        const started = events[0];
        const id = started?._tag === "RunStarted" ? started.conversationId : "";
        const second = yield* Stream.runCollect(
          runner.run({
            agent: talker,
            principal: alice,
            input: "again",
            attachments: [],
            conversationId: Option.some(id),
            model: Option.none(),
            directory: Option.none(),
          }),
        );
        assert.deepStrictEqual(
          second.map((e) => e._tag),
          ["RunStarted", "RunFailed"],
        );
        const failed = second[1];
        assert.isTrue(failed?._tag === "RunFailed" && failed.message.includes("bad key"));
      }),
  );
});
