import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import {
  AgentDefinition,
  CapabilityAnnotation,
  define,
  type Plugin,
  PluginSetupError,
  type Registration,
  ToolCallContext,
  ModelCatalog,
} from "@magentic/plugin";
import { Principal } from "@magentic/protocol";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { AgentRegistry } from "../AgentRegistry.ts";
import { CommandRegistry } from "./CommandRegistry.ts";
import { builtin, PluginHost } from "./PluginHost.ts";
import { ToolCallGuard, ToolRegistry } from "./ToolRegistry.ts";

const Echo = Tool.make("echo", {
  description: "Echoes text",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({ text: Schema.String, by: Schema.String }),
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "fs:read");

const Unclassified = Tool.make("mystery", {
  description: "Declares no capability",
  parameters: Schema.Struct({}),
  success: Schema.String,
});

const EchoKit = Toolkit.make(Echo);

/** A plugin contributing `echo`; the handler reads the call context to prove it is provided. */
const echoPlugin = (id: string) =>
  define({
    id,
    description: "echo",
    setup: Effect.fn(function* (ctx) {
      const handlers = yield* EchoKit.toHandlers({
        echo: ({ text }) =>
          Effect.map(ToolCallContext, (call) => ({ text, by: call.principal.displayName })),
      });
      yield* ctx.tool.registerToolkit(yield* EchoKit.pipe(Effect.provideContext(handlers)));
    }),
  });

const unclassifiedPlugin = define({
  id: "unclassified",
  description: "registers a tool without a capability",
  setup: Effect.fn(function* (ctx) {
    const kit = Toolkit.make(Unclassified);
    const handlers = yield* kit.toHandlers({ mystery: () => Effect.succeed("?") });
    yield* ctx.tool.registerToolkit(yield* kit.pipe(Effect.provideContext(handlers)));
  }),
});

const broken = define({
  id: "broken",
  description: "fails during setup",
  setup: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.agent.transform(() => Effect.void);
      return yield* new PluginSetupError({ plugin: "broken", message: "no thanks" });
    }),
});

const agentsPlugin = define({
  id: "agents",
  description: "contributes one agent",
  setup: (ctx) =>
    Effect.asVoid(
      ctx.agent.transform((draft) =>
        Effect.sync(() =>
          draft.set(
            new AgentDefinition({
              name: "helper",
              description: "",
              prompt: "",
              tools: ["echo", "hidden"],
            }),
          ),
        ),
      ),
    ),
});

const denyPlugin = define({
  id: "deny",
  description: "denies calls that mention secrets",
  setup: (ctx) =>
    Effect.asVoid(
      ctx.tool.hook("execute.before", (event) =>
        Effect.sync(() => {
          if (JSON.stringify(event.params).includes("secret")) {
            event.deny("no secrets");
          }
        }),
      ),
    ),
});

const alice = new Principal({ id: "alice", displayName: "Alice", groups: [], provider: "local" });
const helper = new AgentDefinition({
  name: "helper",
  description: "",
  prompt: "",
  tools: ["echo"],
});

const host = (plugins: ReadonlyArray<Plugin>, disabled: ReadonlyArray<string> = []) =>
  PluginHost.layer({
    plugins: plugins.map(builtin),
    disabled,
    disabledTools: ["hidden"],
    paths: { config: "/nonexistent", workspace: "/nonexistent", data: "/nonexistent" },
  }).pipe(
    Layer.provide(ToolCallGuard.layerAllowAll),
    Layer.provideMerge(
      Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
    ),
  );

const callEcho = (text: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry;
    const kit = yield* registry.forAgent(helper, { runId: "run-1", principal: alice });
    const stream = yield* kit.handle("echo", { text }, "call-1");
    const results = yield* Stream.runCollect(stream);
    return results[0];
  });

layer(
  host([
    echoPlugin("echo"),
    echoPlugin("echo-again"),
    unclassifiedPlugin,
    broken,
    agentsPlugin,
    denyPlugin,
  ]),
)("PluginHost", (it) => {
  it.effect("reports every plugin with its status and contributions", () =>
    Effect.gen(function* () {
      const plugins = yield* (yield* PluginHost).plugins;
      assert.deepStrictEqual(
        plugins.map((p) => [p.id, p.status, p.error]),
        [
          ["echo", "active", undefined],
          ["echo-again", "failed", "tool echo is already registered by another plugin"],
          ["unclassified", "failed", "tool mystery declares no capability"],
          ["broken", "failed", "no thanks"],
          ["agents", "active", undefined],
          ["deny", "active", undefined],
        ],
      );
      assert.deepStrictEqual([...plugins[0]!.tools], ["echo"]);
      assert.deepStrictEqual([...plugins[4]!.agents], ["helper"]);
    }),
  );

  it.effect("a failed plugin leaves nothing behind", () =>
    Effect.gen(function* () {
      const tools = yield* (yield* ToolRegistry).list;
      assert.deepStrictEqual(
        tools.map((t) => t.name),
        ["echo"],
      );
    }),
  );

  it.effect("agents come from transforms and the registry still registers at runtime", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const found = yield* registry.get("helper");
      assert.deepStrictEqual([...found.tools], ["echo", "hidden"]);
      yield* registry.register(
        new AgentDefinition({ name: "late", description: "", prompt: "", tools: [] }),
      );
      assert.deepStrictEqual(
        (yield* registry.list).map((a) => a.name),
        ["helper", "late"],
      );
      const duplicate = yield* registry.register(found).pipe(Effect.flip);
      assert.strictEqual(duplicate._tag, "AgentAlreadyRegistered");
    }),
  );

  it.effect("runs a call with its context and lets hooks deny", () =>
    Effect.gen(function* () {
      const ok = yield* callEcho("hello");
      assert.deepStrictEqual(ok?.encodedResult, { text: "hello", by: "Alice" });
      assert.isFalse(ok?.isFailure);

      const denied = yield* callEcho("my secret");
      assert.isTrue(denied?.isFailure);
      assert.deepStrictEqual(denied?.encodedResult, {
        _tag: "ToolCallRefused",
        tool: "echo",
        reason: "no secrets",
      });
    }),
  );

  it.effect("hides tools an agent did not list or the config disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      const kit = yield* registry.forAgent(
        new AgentDefinition({ name: "x", description: "", prompt: "", tools: ["hidden"] }),
        { runId: "run-2", principal: alice },
      );
      assert.deepStrictEqual(Object.keys(kit.tools), []);
    }),
  );
});

layer(host([echoPlugin("echo")], ["echo"]))("PluginHost with a disabled plugin", (it) => {
  it.effect("skips it entirely", () =>
    Effect.gen(function* () {
      const plugins = yield* (yield* PluginHost).plugins;
      assert.deepStrictEqual(
        plugins.map((p) => p.status),
        ["disabled"],
      );
      assert.deepStrictEqual(yield* (yield* ToolRegistry).list, []);
    }),
  );
});

/** A plugin contributing the `/hello` command. */
const commandPlugin = (id: string) =>
  define({
    id,
    description: "greets",
    setup: (ctx) =>
      Effect.asVoid(
        ctx.command.register({
          name: "hello",
          description: "Say hello",
          run: ({ ui }) => ui.notify(`hello from ${id}`),
        }),
      ),
  });

layer(host([commandPlugin("greeter"), commandPlugin("greeter-again")]))(
  "PluginHost commands",
  (it) => {
    it.effect("are listed once per name; a second plugin claiming it fails", () =>
      Effect.gen(function* () {
        const commands = yield* CommandRegistry;
        assert.deepStrictEqual(
          (yield* commands.list).map((c) => c.name),
          ["hello"],
        );
        const plugins = yield* (yield* PluginHost).plugins;
        assert.deepStrictEqual(
          plugins.map((p) => [p.id, p.status, p.error, [...p.commands]]),
          [
            ["greeter", "active", undefined, ["hello"]],
            [
              "greeter-again",
              "failed",
              "command /hello is already registered by another plugin",
              [],
            ],
          ],
        );
      }),
    );
  },
);

/** A plugin that hands its registration to the test so it can be disposed early. */
const scoped = (handle: Deferred.Deferred<Registration>) =>
  define({
    id: "scoped",
    description: "disposes its tool when told",
    setup: Effect.fn(function* (ctx) {
      const handlers = yield* EchoKit.toHandlers({
        echo: ({ text }) => Effect.succeed({ text, by: "scoped" }),
      });
      const registration = yield* ctx.tool.registerToolkit(
        yield* EchoKit.pipe(Effect.provideContext(handlers)),
      );
      yield* Deferred.succeed(handle, registration);
    }),
  });

const handle = Deferred.makeUnsafe<Registration>();

layer(host([scoped(handle)]))("PluginHost registrations", (it) => {
  it.effect("disappear when disposed", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      assert.deepStrictEqual(
        (yield* registry.list).map((t) => t.name),
        ["echo"],
      );
      const registration = yield* Deferred.await(handle);
      yield* registration.dispose;
      assert.deepStrictEqual(yield* registry.list, []);
      // Disposal is idempotent.
      yield* registration.dispose;
      assert.deepStrictEqual(yield* registry.list, []);
    }),
  );
});
