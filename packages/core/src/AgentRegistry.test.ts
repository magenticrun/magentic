import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";
import { AgentDefinition } from "./Agent.ts";
import { AgentRegistry } from "./AgentRegistry.ts";

const triage = new AgentDefinition({
  name: "triage",
  description: "Triage issues",
  prompt: "Triage issues.",
  tools: [],
});

layer(AgentRegistry.layerMemory())("AgentRegistry", (it) => {
  it.effect("registers and lists agents", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      yield* registry.register(triage);
      const agents = yield* registry.list;
      assert.strictEqual(agents.length, 1);
      assert.strictEqual((yield* registry.get("triage")).name, "triage");
    }),
  );

  it.effect("rejects duplicate names", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const error = yield* registry.register(triage).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentAlreadyRegistered");
    }),
  );

  it.effect("fails with AgentNotFound for unknown names", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const error = yield* registry.get("nope").pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentNotFound");
    }),
  );
});
