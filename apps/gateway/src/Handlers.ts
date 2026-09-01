import { AgentRegistry } from "@magentic/core";
import { AgentInfo, Api } from "@magentic/protocol";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

export const SystemApiHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({ health: () => Effect.void });
  }),
);

const toInfo = (agent: { name: string; description: string; tools: ReadonlyArray<string> }) =>
  new AgentInfo({ name: agent.name, description: agent.description, tools: agent.tools });

/** Handlers without their dependencies, so tests can supply their own registry. */
export const AgentsApiHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "agents",
  Effect.fn(function* (handlers) {
    const registry = yield* AgentRegistry;
    return handlers.handleAll({
      list: () => registry.list.pipe(Effect.map((agents) => agents.map(toInfo))),
      get: ({ params }) => registry.get(params.name).pipe(Effect.map(toInfo)),
    });
  }),
);

export const AgentsApiHandlers = AgentsApiHandlersNoDeps.pipe(
  Layer.provide(AgentRegistry.layerMemory),
);
