import { Audit, AuditEvent } from "@magentic/audit";
import {
  type AgentDefinition,
  AgentRegistry,
  ModelRegistry,
  PluginHost,
  Runner,
} from "@magentic/core";
import { Identity } from "@magentic/identity";
import { Policy } from "@magentic/policy";
import { AgentInfo, AgentRequest, Api, RunDenied, type RunRequest } from "@magentic/protocol";
import { Config, DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

export const SystemApiHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({ health: () => Effect.void });
  }),
);

export const PluginsApiHandlers = HttpApiBuilder.group(
  Api,
  "plugins",
  Effect.fn(function* (handlers) {
    const host = yield* PluginHost;
    return handlers.handleAll({ list: () => host.plugins });
  }),
);

/** Until sessions exist, the OS user is the caller. */
const localSubject = Config.string("USER").pipe(Config.withDefault("local"));

/** Handlers without their dependencies, so tests can supply their own registry and runner. */
export const AgentsApiHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "agents",
  Effect.fn(function* (handlers) {
    const registry = yield* AgentRegistry;
    const models = yield* ModelRegistry;
    const runner = yield* Runner;

    /** What a surface may know, with the model the agent would run on today. */
    const toInfo = Effect.fn("Gateway.toInfo")(function* (agent: AgentDefinition) {
      const resolved = yield* models.resolve(Option.fromNullishOr(agent.model)).pipe(Effect.option);
      const base = { name: agent.name, description: agent.description, tools: agent.tools };
      return new AgentInfo(Option.isSome(resolved) ? { ...base, model: resolved.value.ref } : base);
    });
    const identity = yield* Identity;
    const policy = yield* Policy;
    const audit = yield* Audit;

    const run = Effect.fn("Gateway.run")(function* (name: string, payload: RunRequest) {
      const { input, conversationId, model } = payload;
      const agent = yield* registry.get(name);
      const subject = yield* localSubject.pipe(Effect.orDie);
      const principal = yield* identity.resolve(subject).pipe(Effect.orDie);
      const request = new AgentRequest({
        id: crypto.randomUUID(),
        agent: agent.name,
        surface: "cli",
        principal,
        input,
        createdAt: yield* DateTime.now,
      });
      const decision = yield* policy.evaluate(request);
      if (decision._tag !== "Allow") {
        return yield* new RunDenied({ agent: agent.name, reason: decision.reason });
      }
      yield* audit.record(
        new AuditEvent({
          at: request.createdAt,
          principal,
          action: "run.started",
          detail: { requestId: request.id, agent: agent.name, model },
        }),
      );
      return runner.run({
        agent,
        principal,
        input,
        conversationId: Option.fromNullishOr(conversationId),
        model: Option.fromNullishOr(model),
      });
    });

    return handlers.handleAll({
      list: () => registry.list.pipe(Effect.flatMap(Effect.forEach(toInfo))),
      get: ({ params }) => registry.get(params.name).pipe(Effect.flatMap(toInfo)),
      run: ({ params, payload }) => run(params.name, payload),
    });
  }),
);
