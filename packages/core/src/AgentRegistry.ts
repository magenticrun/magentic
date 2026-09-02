import { AgentNotFound } from "@magentic/protocol";
import { Context, Effect, Layer } from "effect";
import { AgentAlreadyRegistered, type AgentDefinition } from "./Agent.ts";

/** The set of agents a gateway hosts. */
export class AgentRegistry extends Context.Service<
  AgentRegistry,
  {
    register(agent: AgentDefinition): Effect.Effect<void, AgentAlreadyRegistered>;
    get(name: string): Effect.Effect<AgentDefinition, AgentNotFound>;
    readonly list: Effect.Effect<ReadonlyArray<AgentDefinition>>;
  }
>()("magentic/core/AgentRegistry") {
  /**
   * Process-local registry, seeded with `initial`. Enough for a single
   * gateway; not shared across instances.
   */
  static readonly layerMemory = (initial: ReadonlyArray<AgentDefinition> = []) =>
    Layer.effect(
      AgentRegistry,
      Effect.gen(function* () {
        const agents = new Map<string, AgentDefinition>();

        const register = Effect.fn("AgentRegistry.register")(function* (agent: AgentDefinition) {
          if (agents.has(agent.name)) {
            return yield* new AgentAlreadyRegistered({ name: agent.name });
          }
          agents.set(agent.name, agent);
        });

        const get = Effect.fn("AgentRegistry.get")(function* (name: string) {
          const agent = agents.get(name);
          if (agent === undefined) {
            return yield* new AgentNotFound({ name });
          }
          return agent;
        });

        const list = Effect.sync(() => [...agents.values()]);

        for (const agent of initial) {
          yield* register(agent);
        }

        return AgentRegistry.of({ register, get, list });
      }),
    );
}
