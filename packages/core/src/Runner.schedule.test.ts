import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { fakeProviderPlugin, type FakeScript } from "@magentic/model";
import { AgentDefinition, ModelCatalog, Notices } from "@magentic/plugin";
import { Principal } from "@magentic/protocol";
import { DateTime, Effect, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ConversationStore } from "./ConversationStore.ts";
import { builtin, PluginHost } from "./plugin/PluginHost.ts";
import { ToolCallGuard } from "./plugin/ToolRegistry.ts";
import { Runner } from "./Runner.ts";
import { ScheduledTaskStore } from "./ScheduledTaskStore.ts";
import { ScheduledTasks } from "./ScheduledTasks.ts";
import { Steering } from "./Steering.ts";
import { transcriptFromJson } from "./Transcript.ts";

const talker = new AgentDefinition({
  name: "talker",
  description: "Says what it was told",
  prompt: "You answer.",
  tools: [],
});

const alice = new Principal({ id: "alice", displayName: "Alice", groups: [], provider: "local" });
const bob = new Principal({ id: "bob", displayName: "Bob", groups: [], provider: "local" });

/** Answers with the last user text it was given, so a turn's input is visible in its reply. */
const script: FakeScript = ({ options }) => {
  const said = options.prompt.content
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
  return [{ type: "text", text: `heard:${said.at(-1) ?? ""}` }];
};

const HostLayer = PluginHost.layer({
  plugins: [builtin(fakeProviderPlugin(script))],
  paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
}).pipe(Layer.provide(ToolCallGuard.layerAllowAll));

const TestLayer = Runner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      HostLayer,
      ConversationStore.layerMemory,
      Steering.layer,
      Notices.layer,
      ScheduledTasks.layer.pipe(Layer.provideMerge(ScheduledTaskStore.layerMemory)),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

const MINUTE = 60_000;

/** A conversation that has run once, so it exists on disk for a schedule to belong to. */
const started = Effect.fn("started")(function* (principal = alice) {
  const runner = yield* Runner;
  const events = yield* Stream.runCollect(
    runner.run({
      agent: talker,
      principal,
      input: "hello",
      attachments: [],
      conversationId: Option.none(),
      model: Option.none(),
      directory: Option.none(),
      reasoning: Option.none(),
    }),
  );
  const opened = events.find((event) => event._tag === "RunStarted");
  assert.isDefined(opened);
  return opened.conversationId;
});

const armed = Effect.fn("armed")(function* (conversationId: string, prompt: string) {
  const schedules = yield* ScheduledTasks;
  return yield* schedules.create({
    conversationId,
    agent: talker.name,
    kind: "prompt",
    prompt,
    intervalMillis: 10 * MINUTE,
    missed: "once",
    expiresAt: Option.none(),
  });
});

const woken = Effect.fn("woken")(function* (conversationId: string) {
  const runner = yield* Runner;
  return yield* Stream.runCollect(
    runner.wake({
      agent: talker,
      principal: alice,
      conversationId,
      model: Option.none(),
      reasoning: Option.none(),
    }),
  );
});

layer(TestLayer)("Runner with a schedule", (it) => {
  it.effect("says nothing when a schedule is armed but nothing is due", () =>
    Effect.gen(function* () {
      const conversationId = yield* started();
      yield* armed(conversationId, "check the deploy");
      // Armed is not due: a wake-up with nothing waiting emits no events at
      // all, which is what keeps an idle loop from costing anything.
      assert.deepStrictEqual([...(yield* woken(conversationId))], []);
    }),
  );

  it.effect("speaks to a fire that is waiting, marked apart from what the person typed", () =>
    Effect.gen(function* () {
      const store = yield* ConversationStore;
      const conversationId = yield* started();
      const task = yield* armed(conversationId, "check the deploy");

      const file = yield* (yield* ScheduledTaskStore).read(conversationId);
      const now = yield* DateTime.now;
      yield* (yield* ScheduledTaskStore).write(conversationId, {
        ...file,
        inbox: [
          {
            id: `${task.id}:1`,
            taskId: task.id,
            slotAt: now,
            prompt: "check the deploy",
            admittedAt: now,
          },
        ],
      });

      const events = yield* woken(conversationId);
      assert.include(
        events.map((event) => event._tag),
        "RunStarted",
      );
      const said = events.flatMap((event) => (event._tag === "TextDelta" ? [event.text] : []));
      assert.isTrue(
        said.some((text) => text.includes("check the deploy")),
        `the schedule's own words reached the model: ${said.join("")}`,
      );

      // The fire is gone from the inbox and the task counted the run.
      const after = yield* (yield* ScheduledTaskStore).read(conversationId);
      assert.strictEqual(after.inbox.length, 0);
      assert.strictEqual(after.tasks.at(0)?.runCount, 1);

      // In the transcript it is a Scheduled entry, not something the person
      // said and not a notice from a background task.
      const history = yield* store.history(conversationId);
      assert.isTrue(Option.isSome(history));
      const transcript = yield* transcriptFromJson(Option.getOrThrow(history));
      const tags = transcript.map((entry) => entry._tag);
      assert.include(tags, "Scheduled");
      assert.deepStrictEqual(
        transcript.filter((entry) => entry._tag === "User").map((entry) => entry.text),
        ["hello"],
      );
    }),
  );

  it.effect("takes one fire per turn, so a backlog does not become one long turn", () =>
    Effect.gen(function* () {
      const conversationId = yield* started();
      const task = yield* armed(conversationId, "tick");
      const store = yield* ScheduledTaskStore;
      const file = yield* store.read(conversationId);
      const now = yield* DateTime.now;
      yield* store.write(conversationId, {
        ...file,
        inbox: [1, 2, 3].map((slot) => ({
          id: `${task.id}:${slot}`,
          taskId: task.id,
          slotAt: now,
          prompt: `tick ${slot}`,
          admittedAt: now,
        })),
      });

      yield* woken(conversationId);
      assert.strictEqual((yield* store.read(conversationId)).inbox.length, 2);
      yield* woken(conversationId);
      assert.strictEqual((yield* store.read(conversationId)).inbox.length, 1);
    }),
  );

  it.effect("leaves another principal's conversation alone", () =>
    Effect.gen(function* () {
      const runner = yield* Runner;
      const conversationId = yield* started(bob);
      const task = yield* armed(conversationId, "tick");
      const store = yield* ScheduledTaskStore;
      const file = yield* store.read(conversationId);
      const now = yield* DateTime.now;
      yield* store.write(conversationId, {
        ...file,
        inbox: [
          { id: `${task.id}:1`, taskId: task.id, slotAt: now, prompt: "tick", admittedAt: now },
        ],
      });
      // Alice waking Bob's conversation gets nothing, and the fire is still
      // there for its owner.
      const events = yield* Stream.runCollect(
        runner.wake({
          agent: talker,
          principal: alice,
          conversationId,
          model: Option.none(),
          reasoning: Option.none(),
        }),
      );
      assert.deepStrictEqual([...events], []);
      assert.strictEqual((yield* store.read(conversationId)).inbox.length, 1);
    }),
  );
});
