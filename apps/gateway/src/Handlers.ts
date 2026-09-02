import { Audit, AuditEvent } from "@magentic/audit";
import {
  type AgentDefinition,
  AgentRegistry,
  ConversationStore,
  ModelRegistry,
  PluginHost,
  Runner,
  transcriptFromJson,
} from "@magentic/core";
import { Identity } from "@magentic/identity";
import { Policy } from "@magentic/policy";
import {
  AgentInfo,
  AgentRequest,
  Api,
  CompactionFailed,
  type Conversation,
  ConversationNotFound,
  RunDenied,
  type RunRequest,
} from "@magentic/protocol";
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

/** Who is calling, resolved the way every handler does it for now. */
const callerVia = (identity: Identity["Service"]) =>
  localSubject.pipe(
    Effect.orDie,
    Effect.flatMap((subject) => identity.resolve(subject).pipe(Effect.orDie)),
  );

/** The caller's conversation with this id; anyone else's is not found. */
const owned = Effect.fn("Gateway.ownedConversation")(function* (
  store: ConversationStore["Service"],
  principalId: string,
  id: string,
) {
  const found = yield* store.get(id);
  if (Option.isNone(found) || found.value.principal !== principalId) {
    return yield* new ConversationNotFound({ id });
  }
  return found.value;
});

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
    const caller = callerVia(yield* Identity);
    const policy = yield* Policy;
    const audit = yield* Audit;
    const conversations = yield* ConversationStore;

    const run = Effect.fn("Gateway.run")(function* (name: string, payload: RunRequest) {
      const { input, attachments, conversationId, model, directory } = payload;
      const agent = yield* registry.get(name);
      const principal = yield* caller;
      // Continuing a conversation means one of the caller's own. An unknown id starts one.
      if (conversationId !== undefined) {
        const found = yield* conversations.get(conversationId);
        if (Option.isSome(found) && found.value.principal !== principal.id) {
          return yield* new ConversationNotFound({ id: conversationId });
        }
      }
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
        attachments: attachments ?? [],
        conversationId: Option.fromNullishOr(conversationId),
        model: Option.fromNullishOr(model),
        directory: Option.fromNullishOr(directory),
      });
    });

    return handlers.handleAll({
      list: () => registry.list.pipe(Effect.flatMap(Effect.forEach(toInfo))),
      get: ({ params }) => registry.get(params.name).pipe(Effect.flatMap(toInfo)),
      run: ({ params, payload }) => run(params.name, payload),
    });
  }),
);

/** Handlers without their dependencies, so tests can supply their own store and runner. */
export const ConversationsApiHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "conversations",
  Effect.fn(function* (handlers) {
    const store = yield* ConversationStore;
    const registry = yield* AgentRegistry;
    const runner = yield* Runner;
    const caller = callerVia(yield* Identity);

    const list = Effect.fn("Gateway.conversations.list")(function* (
      agent: string | undefined,
      directory: string | undefined,
    ) {
      const principal = yield* caller;
      const all = yield* store.list;
      return all.filter(
        (c: Conversation) =>
          c.principal === principal.id &&
          (agent === undefined || c.agent === agent) &&
          (directory === undefined || c.directory === directory),
      );
    });

    const transcript = Effect.fn("Gateway.conversations.transcript")(function* (id: string) {
      const principal = yield* caller;
      yield* owned(store, principal.id, id);
      const history = yield* store.history(id);
      if (Option.isNone(history)) {
        return [];
      }
      // A history that no longer decodes is an empty transcript, not a failed resume.
      return yield* transcriptFromJson(history.value).pipe(Effect.orElseSucceed(() => []));
    });

    const remove = Effect.fn("Gateway.conversations.remove")(function* (id: string) {
      const principal = yield* caller;
      yield* owned(store, principal.id, id);
      yield* store.remove(id).pipe(Effect.orDie);
    });

    /** The summary is written by the model the conversation last ran on. */
    const compact = Effect.fn("Gateway.conversations.compact")(function* (id: string) {
      const principal = yield* caller;
      const info = yield* owned(store, principal.id, id);
      const agent = yield* registry
        .get(info.agent)
        .pipe(Effect.mapError((error) => new CompactionFailed({ id, message: error.message })));
      return yield* runner
        .compact({ conversationId: id, agent, model: Option.fromNullishOr(info.model) })
        .pipe(Effect.mapError((error) => new CompactionFailed({ id, message: error.message })));
    });

    return handlers.handleAll({
      list: ({ query }) => list(query.agent, query.directory),
      get: ({ params }) => Effect.flatMap(caller, (p) => owned(store, p.id, params.id)),
      transcript: ({ params }) => transcript(params.id),
      remove: ({ params }) => remove(params.id),
      compact: ({ params }) => compact(params.id),
    });
  }),
);
