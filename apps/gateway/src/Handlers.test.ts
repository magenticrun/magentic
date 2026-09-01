import { assert, layer } from "@effect/vitest";
import { AgentDefinition, AgentRegistry } from "@magentic/core";
import { Api } from "@magentic/protocol";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiTest } from "effect/unstable/httpapi";
import { AgentsApiHandlersNoDeps, SystemApiHandlers } from "./Handlers.ts";

const makeClient = HttpApiTest.groups(Api, ["system", "agents"]);

const HandlersLayer = Layer.mergeAll(
  SystemApiHandlers,
  AgentsApiHandlersNoDeps.pipe(Layer.provideMerge(AgentRegistry.layerMemory)),
);

layer(Layer.mergeAll(HandlersLayer, HttpServer.layerServices))("gateway api", (it) => {
  it.effect("GET /health", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.health();
    }),
  );

  it.effect("lists registered agents", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      yield* registry.register(
        new AgentDefinition({ name: "triage", description: "Triage issues", tools: ["search"] }),
      );

      const client = yield* makeClient;
      const agents = yield* client.agents.list();
      assert.deepStrictEqual(
        agents.map((a) => a.name),
        ["triage"],
      );

      const triage = yield* client.agents.get({ params: { name: "triage" } });
      assert.deepStrictEqual([...triage.tools], ["search"]);
    }),
  );

  it.effect("returns 404 for unknown agents", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const error = yield* client.agents.get({ params: { name: "nope" } }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentNotFound");
    }),
  );
});
