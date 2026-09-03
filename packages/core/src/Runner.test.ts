import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import {
  AgentDefinition,
  CapabilityAnnotation,
  define,
  ModelCatalog,
  Notices,
} from "@magentic/plugin";
import { Principal, type RunEvent } from "@magentic/protocol";
import {
  BackgroundTasks,
  fileToolsPlugin,
  shellToolPlugin,
  ToolOutputDir,
  WorkspaceRoot,
} from "@magentic/tools";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { AiError, type Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { ConversationStore } from "./ConversationStore.ts";
import { builtin, PluginHost } from "./plugin/PluginHost.ts";
import { ToolCallGuard } from "./plugin/ToolRegistry.ts";
import { Runner } from "./Runner.ts";
import { Steering } from "./Steering.ts";
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
  Layer.provideMerge(Layer.mergeAll(HostLayer, StoreLayer, Steering.layer, Notices.layer)),
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
          reasoning: Option.none(),
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
          reasoning: Option.none(),
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
          reasoning: Option.none(),
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
      Steering.layer,
      Notices.layer,
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
          reasoning: Option.none(),
        }),
      );
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        [
          "RunStarted",
          "TextDelta",
          "TokenUsage",
          "CompactionStarted",
          "Compacted",
          "TokenUsage",
          "RunFinished",
        ],
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
          reasoning: Option.none(),
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
      Steering.layer,
      Notices.layer,
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
              reasoning: Option.none(),
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
            reasoning: Option.none(),
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

/**
 * Asks for the file again on every call, so only the step limit ends the run,
 * and answers in text when the call comes with no tools, as a provider does.
 */
const looping: FakeScript = ({ index, options }) =>
  options.tools.length === 0
    ? [{ type: "text", text: "read it twice" }]
    : [
        {
          type: "tool-call",
          id: `call-${index}`,
          name: "read_file",
          params: { path: "hello.txt" },
        },
      ];

const LoopingLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.layer({
        plugins: [builtin(fileToolsPlugin), builtin(fakeProviderPlugin(looping))],
        paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
      }).pipe(Layer.provide([WorkspaceLayer, ToolCallGuard.layerAllowAll])),
      ConversationStore.layerMemory,
      Steering.layer,
      Notices.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(LoopingLayer)("Runner step limit", (it) => {
  it.effect("ends a run that never stops calling tools at the agent's step limit", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      const events = yield* Stream.runCollect(
        runner.run({
          agent: new AgentDefinition({ ...reader, maxSteps: 2 }),
          principal: alice,
          input: "loop",
          attachments: [],
          conversationId: Option.none(),
          model: Option.none(),
          directory: Option.none(),
          reasoning: Option.none(),
        }),
      );
      assert.strictEqual(events.filter((e) => e._tag === "ToolCall").length, 2);
      // The step it lands on has no tools left, and goes on saying where the work stands.
      const said = events.flatMap((e) => (e._tag === "TextDelta" ? [e.text] : [])).join("");
      assert.strictEqual(said, "read it twice");
      const last = events.at(-1);
      assert.isTrue(last?._tag === "RunFinished" && last.reason === "step-limit");
      // The history keeps the tool results, so the next input continues from them.
      const started = events[0];
      const id = started?._tag === "RunStarted" ? started.conversationId : "";
      const store = yield* ConversationStore;
      const saved = yield* store.get(id);
      // The notice asking for the account, and the account, are both in it.
      assert.strictEqual(Option.isSome(saved) ? saved.value.messages : 0, 8);
    }),
  );
});

/** Answers with what the last message said and how hard it was asked to think, after one call to `wait`. */
const steerable: FakeScript = ({ index, options, reasoning }) => {
  if (index === 0) {
    return [{ type: "tool-call", id: "call-1", name: "wait", params: {} }];
  }
  const last = options.prompt.content.at(-1);
  const said =
    last?.role === "user"
      ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      : `a ${last?.role ?? "nothing"}`;
  return [
    {
      type: "text",
      text: `saw ${said}; thinking ${Option.getOrElse(reasoning, () => "default")}`,
    },
  ];
};

/** A tool that returns when the test says so, holding the run between its model calls. */
const Wait = Tool.make("wait", {
  description: "Waits for the test.",
  parameters: Schema.Struct({ note: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ ok: Schema.Boolean }),
}).annotate(CapabilityAnnotation, "fs:read");
const WaitTools = Toolkit.make(Wait);
const waitingOn = (gate: Deferred.Deferred<void>) =>
  define({
    id: "wait",
    description: "The wait tool.",
    setup: (ctx) =>
      Effect.gen(function* () {
        const handlers = yield* WaitTools.toHandlers(
          Effect.succeed(
            WaitTools.of({ wait: () => Effect.as(Deferred.await(gate), { ok: true }) }),
          ),
        );
        yield* ctx.tool.registerToolkit(yield* WaitTools.pipe(Effect.provideContext(handlers)));
      }),
  });
const gate = Deferred.makeUnsafe<void>();
const waitPlugin = waitingOn(gate);

const waiter = new AgentDefinition({
  name: "waiter",
  description: "Waits",
  prompt: "You wait.",
  tools: ["wait"],
});

const SteeringLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.layer({
        plugins: [
          builtin(waitPlugin),
          builtin(
            fakeProviderPlugin(steerable, { context: 0, output: 0, cost: { input: 1, output: 2 } }),
          ),
        ],
        paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
      }).pipe(Layer.provide(ToolCallGuard.layerAllowAll)),
      ConversationStore.layerMemory,
      Steering.layer,
      Notices.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(SteeringLayer)("Runner steering, thinking, and cost", (it) => {
  it.effect("shows the model what was steered in before its next call, at the level asked", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      const steering = yield* Steering;
      const seen = yield* Ref.make<ReadonlyArray<RunEvent>>([]);
      const runId = yield* Ref.make("");
      yield* runner
        .run({
          agent: waiter,
          principal: alice,
          input: "start",
          attachments: [],
          conversationId: Option.none(),
          model: Option.none(),
          directory: Option.none(),
          reasoning: Option.some("high"),
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              yield* Ref.update(seen, (all) => [...all, event]);
              if (event._tag === "RunStarted") {
                yield* Ref.set(runId, event.runId);
              }
              // The tool is waiting on the gate, so this arrives before the next model call.
              if (event._tag === "ToolCall") {
                const id = yield* Ref.get(runId);
                assert.isTrue(
                  yield* steering.offer(id, alice.id, { input: "also this", attachments: [] }),
                );
                // Someone else's input is not taken.
                assert.isFalse(
                  yield* steering.offer(id, "mallory", { input: "no", attachments: [] }),
                );
                yield* Deferred.succeed(gate, undefined);
              }
            }),
          ),
        );
      const events = yield* Ref.get(seen);
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        [
          "RunStarted",
          "ToolCall",
          "ToolResult",
          "TokenUsage",
          "Steered",
          "TextDelta",
          "TokenUsage",
          "RunFinished",
        ],
      );
      assert.deepStrictEqual(events[4], { _tag: "Steered", inputs: ["also this"] });
      const reply = events[5];
      assert.strictEqual(
        reply?._tag === "TextDelta" ? reply.text : reply,
        "saw also this; thinking high",
      );
      // Ten input tokens at $1 and one output token at $2 a million, each call.
      const usage = events[3];
      assert.isTrue(usage?._tag === "TokenUsage" && usage.cost !== undefined);
      if (usage?._tag === "TokenUsage" && usage.cost !== undefined) {
        assert.closeTo(usage.cost, 12e-6, 1e-12);
      }
      const started = events[0];
      const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
      const saved = yield* (yield* ConversationStore).get(conversationId);
      assert.closeTo(Option.isSome(saved) ? (saved.value.usage?.totalCost ?? 0) : 0, 24e-6, 1e-12);
      // The steered input is a user turn in the history, between the tool and the answer.
      const transcript = yield* transcriptFromJson(
        Option.getOrElse(yield* (yield* ConversationStore).history(conversationId), () => ""),
      );
      assert.deepStrictEqual(
        transcript.map((e) => (e._tag === "User" ? `User:${e.text}` : e._tag)),
        ["User:start", "Tool", "User:also this", "Assistant"],
      );
      // A run that has ended takes nothing more.
      const id = yield* Ref.get(runId);
      assert.isFalse(yield* steering.offer(id, alice.id, { input: "late", attachments: [] }));
      assert.deepStrictEqual(yield* steering.retract(id, alice.id), []);
    }),
  );

  it.effect("runs at the model's default when the level is not one of its own", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      yield* Deferred.succeed(gate, undefined);
      const events = yield* Stream.runCollect(
        runner.run({
          agent: waiter,
          principal: alice,
          input: "start",
          attachments: [],
          conversationId: Option.none(),
          model: Option.none(),
          directory: Option.none(),
          reasoning: Option.some("ultra"),
        }),
      );
      // The fake's second run makes no tool call: one answer, to the input, at the default.
      const reply = events.find((e) => e._tag === "TextDelta");
      assert.strictEqual(
        reply?._tag === "TextDelta" ? reply.text : reply,
        "saw start; thinking default",
      );
    }),
  );
});

/** Calls `wait` first; answers every later call with the roles of what it was sent. */
const stoppable: FakeScript = ({ index, options }) =>
  index === 0
    ? [{ type: "tool-call", id: "call-1", name: "wait", params: {} }]
    : [{ type: "text", text: options.prompt.content.map((message) => message.role).join(",") }];

/** A gate nothing opens: the run holds in the tool until it is stopped. */
const shut = Deferred.makeUnsafe<void>();

const InterruptLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.layer({
        plugins: [builtin(waitingOn(shut)), builtin(fakeProviderPlugin(stoppable))],
        paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
      }).pipe(Layer.provide(ToolCallGuard.layerAllowAll)),
      ConversationStore.layerMemory,
      Steering.layer,
      Notices.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(InterruptLayer)("Runner interruption", (it) => {
  it.effect(
    "keeps the turn of a run stopped inside a tool, the call answered, for the next input",
    () =>
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* ConversationStore;
        const conversationId = yield* Ref.make("");
        const called = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(
          runner
            .run({
              agent: waiter,
              principal: alice,
              input: "start",
              attachments: [],
              conversationId: Option.none(),
              model: Option.none(),
              directory: Option.none(),
              reasoning: Option.none(),
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event._tag === "RunStarted") {
                    yield* Ref.set(conversationId, event.conversationId);
                  }
                  if (event._tag === "ToolCall") {
                    yield* Deferred.succeed(called, undefined);
                  }
                }),
              ),
            ),
        );
        yield* Deferred.await(called);
        yield* Fiber.interrupt(running);

        // The input, the call, and a failed result for it are on disk.
        const id = yield* Ref.get(conversationId);
        const transcript = yield* transcriptFromJson(
          Option.getOrElse(yield* store.history(id), () => ""),
        );
        assert.deepStrictEqual(
          transcript.map((e) => (e._tag === "User" ? `User:${e.text}` : e._tag)),
          ["User:start", "Tool"],
        );
        const call = transcript[1];
        assert.isTrue(
          call?._tag === "Tool" &&
            call.isFailure &&
            JSON.stringify(call.result).includes("ended before this tool finished"),
        );
        const saved = yield* store.get(id);
        assert.strictEqual(Option.isSome(saved) ? saved.value.messages : 0, 4);

        // The next input follows that turn, as the model sees it.
        const events = yield* Stream.runCollect(
          runner.run({
            agent: waiter,
            principal: alice,
            input: "again",
            attachments: [],
            conversationId: Option.some(id),
            model: Option.none(),
            directory: Option.none(),
            reasoning: Option.none(),
          }),
        );
        const reply = events.find((e) => e._tag === "TextDelta");
        assert.strictEqual(
          reply?._tag === "TextDelta" ? reply.text : reply,
          "system,user,assistant,tool,user",
        );
      }),
  );
});

/** The id of the first background task a tool result in the prompt carries. */
const taskIdIn = (prompt: Prompt.Prompt): string => {
  for (const message of prompt.content) {
    if (message.role !== "tool") {
      continue;
    }
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        Predicate.hasProperty(part.result, "taskId") &&
        Predicate.isString(part.result.taskId)
      ) {
        return part.result.taskId;
      }
    }
  }
  return "none";
};

const lastUserText = (prompt: Prompt.Prompt): string => {
  const last = prompt.content.at(-1);
  return last?.role === "user"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : `a ${last?.role ?? "nothing"}`;
};

/** Call 0 starts a command in the background, call 1 reads it after waiting, call 2 answers. */
const reading: FakeScript = ({ index, options }) => {
  if (index === 0) {
    return [
      {
        type: "tool-call",
        id: "bg-1",
        name: "shell",
        params: { command: "echo out; echo err >&2; sleep 0.2; echo done", background: true },
      },
    ];
  }
  if (index === 1) {
    return [
      {
        type: "tool-call",
        id: "bg-2",
        name: "task_output",
        params: { taskId: taskIdIn(options.prompt) },
      },
    ];
  }
  return [{ type: "text", text: "read it" }];
};

/** Call 0 starts a long command in the background, call 1 stops it, call 2 answers. */
const stopping: FakeScript = ({ index, options }) => {
  if (index === 0) {
    return [
      {
        type: "tool-call",
        id: "bg-1",
        name: "shell",
        params: { command: "sleep 30", background: true },
      },
    ];
  }
  if (index === 1) {
    return [
      {
        type: "tool-call",
        id: "bg-2",
        name: "task_stop",
        params: { taskId: taskIdIn(options.prompt) },
      },
    ];
  }
  return [{ type: "text", text: "stopped it" }];
};

/** Call 0 starts a short command in the background, call 1 waits on the test, call 2 answers with what it last heard. */
const unwaited: FakeScript = ({ index, options }) => {
  if (index === 0) {
    return [
      {
        type: "tool-call",
        id: "bg-1",
        name: "shell",
        params: { command: "sleep 0.1; echo late", background: true },
      },
    ];
  }
  if (index === 1) {
    return [{ type: "tool-call", id: "wait-1", name: "wait", params: {} }];
  }
  return [{ type: "text", text: `saw ${lastUserText(options.prompt)}` }];
};

/** Answers with every user text so far, in order. */
const echoing: FakeScript = ({ options }) => [
  {
    type: "text",
    text: options.prompt.content
      .flatMap((message) =>
        message.role === "user"
          ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
          : [],
      )
      .join("|"),
  },
];

const shellUser = new AgentDefinition({
  name: "shell-user",
  description: "Runs commands",
  prompt: "You run commands.",
  tools: ["shell", "task_output", "task_stop", "wait"],
});

const lateGate = Deferred.makeUnsafe<void>();

/** A host with the shell plugin over a scratch workspace and data directory, driven by `script`. */
const backgroundLayer = (driver: FakeScript) =>
  Runner.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PluginHost.layer({
          plugins: [
            builtin(shellToolPlugin),
            builtin(waitingOn(lateGate)),
            builtin(fakeProviderPlugin(driver)),
          ],
          paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
        }).pipe(Layer.provide([WorkspaceLayer, ToolCallGuard.layerAllowAll])),
        ConversationStore.layerMemory,
        Steering.layer,
      ),
    ),
    // The tasks are the host's, as they are the gateway's, with their outputs in a scratch directory.
    Layer.provideMerge(
      BackgroundTasks.layer.pipe(
        Layer.provideMerge(
          Layer.unwrap(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const data = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-data-" });
              return ToolOutputDir.layer(`${data}/tool-output`);
            }),
          ),
        ),
      ),
    ),
    // The one board the shell plugin posts to and the runner reads from.
    Layer.provideMerge(Notices.layer),
    Layer.provideMerge(
      Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
    ),
  );

const runOnce = (agent: AgentDefinition, input: string, conversationId: Option.Option<string>) =>
  Effect.flatMap(Runner, (runner) =>
    Stream.runCollect(
      runner.run({
        agent,
        principal: alice,
        input,
        attachments: [],
        conversationId,
        model: Option.none(),
        directory: Option.none(),
        reasoning: Option.none(),
      }),
    ),
  );

const resultOf = (events: ReadonlyArray<RunEvent>, id: string): Schema.Json => {
  const found = events.find((e) => e._tag === "ToolResult" && e.id === id);
  return found?._tag === "ToolResult" ? found.result : null;
};

const field = (value: Schema.Json, key: string): Schema.Json => {
  if (!Predicate.isObject(value) || Array.isArray(value)) {
    return null;
  }
  const found = value[key];
  return Schema.is(Schema.Json)(found) ? found : null;
};

layer(backgroundLayer(reading), { excludeTestServices: true })(
  "Runner background tasks, read",
  (it) => {
    it.effect(
      "a background command returns at once and task_output waits for what it printed",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const events = yield* runOnce(shellUser, "start", Option.none());
          assert.deepStrictEqual(
            events.map((e) => e._tag),
            [
              "RunStarted",
              "ToolCall",
              "ToolResult",
              "TokenUsage",
              "ToolCall",
              "ToolResult",
              "TokenUsage",
              "TextDelta",
              "TokenUsage",
              "RunFinished",
            ],
          );
          const started = resultOf(events, "bg-1");
          assert.isTrue(Predicate.isString(field(started, "taskId")));
          assert.include(String(field(started, "message")), "background");
          // The task ended while the read waited, so its end came back as the result, not as news.
          const read = resultOf(events, "bg-2");
          assert.strictEqual(field(read, "running"), false);
          assert.strictEqual(field(read, "exitCode"), 0);
          assert.strictEqual(field(read, "stdout"), "out\ndone\n");
          assert.strictEqual(field(read, "stderr"), "err\n");
          assert.strictEqual(field(read, "truncated"), false);
          assert.strictEqual(
            yield* fs.readFileString(String(field(read, "stdoutFile"))),
            "out\ndone\n",
          );
        }),
    );
  },
);

layer(backgroundLayer(stopping), { excludeTestServices: true })(
  "Runner background tasks, stop",
  (it) => {
    it.effect("task_stop ends a running command and says so", () =>
      Effect.gen(function* () {
        const events = yield* runOnce(shellUser, "start", Option.none());
        const stopped = resultOf(events, "bg-2");
        assert.strictEqual(field(stopped, "running"), false);
        assert.strictEqual(field(stopped, "stopped"), true);
        assert.strictEqual(field(stopped, "exitCode"), null);
        assert.isBelow(Number(field(stopped, "durationMs")), 10_000);
        assert.isFalse(events.some((e) => e._tag === "Notified"));
      }),
    );
  },
);

layer(backgroundLayer(unwaited), { excludeTestServices: true })(
  "Runner background tasks, notice",
  (it) => {
    it.effect("a task that ends with nobody waiting is announced before the next model call", () =>
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* ConversationStore;
        const seen = yield* Ref.make<ReadonlyArray<RunEvent>>([]);
        yield* runner
          .run({
            agent: shellUser,
            principal: alice,
            input: "start",
            attachments: [],
            conversationId: Option.none(),
            model: Option.none(),
            directory: Option.none(),
            reasoning: Option.none(),
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                yield* Ref.update(seen, (all) => [...all, event]);
                // Hold the run in the tool until the command has surely ended.
                if (event._tag === "ToolCall" && event.name === "wait") {
                  yield* Effect.sleep("800 millis");
                  yield* Deferred.succeed(lateGate, undefined);
                }
              }),
            ),
          );
        const events = yield* Ref.get(seen);
        const notified = events.find((e) => e._tag === "Notified");
        const notice = notified?._tag === "Notified" ? (notified.notices[0] ?? "") : "";
        assert.match(
          notice,
          /^Background task \w+ ended: `sleep 0\.1; echo late` exited with code 0/,
        );
        assert.include(notice, "Last output:\n```\nlate\n```");
        // The notice reached the model as a user message of its own before it answered.
        const reply = events.find((e) => e._tag === "TextDelta");
        assert.isTrue(
          reply?._tag === "TextDelta" &&
            reply.text.startsWith("saw From the harness, not the person"),
        );
        const started = events[0];
        const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
        const transcript = yield* transcriptFromJson(
          Option.getOrElse(yield* store.history(conversationId), () => ""),
        );
        assert.deepStrictEqual(
          transcript.map((e) => e._tag),
          ["User", "Tool", "Tool", "Notice", "Assistant"],
        );
      }),
    );
  },
);

layer(backgroundLayer(echoing))("Runner notices between runs", (it) => {
  it.effect("a notice posted after a run ended goes before the next input", () =>
    Effect.gen(function* () {
      const notices = yield* Notices;
      const first = yield* runOnce(shellUser, "start", Option.none());
      const started = first[0];
      const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
      assert.isFalse(first.some((e) => e._tag === "Notified"));
      yield* notices.post(conversationId, "the harness says hi");
      const second = yield* runOnce(shellUser, "again", Option.some(conversationId));
      assert.deepStrictEqual(
        second.map((e) => e._tag),
        ["RunStarted", "Notified", "TextDelta", "TokenUsage", "RunFinished"],
      );
      assert.deepStrictEqual(second[1], { _tag: "Notified", notices: ["the harness says hi"] });
      const reply = second[2];
      assert.strictEqual(
        reply?._tag === "TextDelta" ? reply.text : reply,
        "start|From the harness, not the person, while you worked:\n\nthe harness says hi|again",
      );
      // Nothing is pending once taken.
      assert.deepStrictEqual(yield* notices.take(conversationId), []);
    }),
  );

  it.effect("a wake-up speaks to what was posted, and says nothing when nothing was", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      const notices = yield* Notices;
      const first = yield* runOnce(shellUser, "start", Option.none());
      const started = first[0];
      const conversationId = started?._tag === "RunStarted" ? started.conversationId : "";
      const wake = (principal: Principal) =>
        Stream.runCollect(
          runner.wake({
            agent: shellUser,
            principal,
            conversationId,
            model: Option.none(),
            reasoning: Option.none(),
          }),
        );
      // Nothing posted: no run, no event.
      assert.deepStrictEqual(yield* wake(alice), []);
      yield* notices.post(conversationId, "the task ended");
      // Another's conversation is not theirs to wake; the notice stays for its owner.
      const bob = new Principal({ id: "bob", displayName: "Bob", groups: [], provider: "local" });
      assert.deepStrictEqual(yield* wake(bob), []);
      const woken = yield* wake(alice);
      assert.deepStrictEqual(
        woken.map((e) => e._tag),
        ["RunStarted", "Notified", "TextDelta", "TokenUsage", "RunFinished"],
      );
      const reply = woken[2];
      assert.strictEqual(
        reply?._tag === "TextDelta" ? reply.text : reply,
        "start|From the harness, not the person, while you worked:\n\nthe task ended",
      );
      // The wake-up's turn is in the history the next input continues from.
      const next = yield* runOnce(shellUser, "again", Option.some(conversationId));
      const later = next.find((e) => e._tag === "TextDelta");
      assert.strictEqual(
        later?._tag === "TextDelta" ? later.text : later,
        "start|From the harness, not the person, while you worked:\n\nthe task ended|again",
      );
    }),
  );
});
