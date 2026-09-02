import { Audit, AuditEvent } from "@magentic/audit";
import {
  type AgentDefinition,
  AgentRegistry,
  ConversationStore,
  ModelRegistry,
  PluginHost,
  Runner,
  Steering,
  transcriptFromJson,
} from "@magentic/core";
import { Identity } from "@magentic/identity";
import { McpServers } from "@magentic/mcp";
import { Policy } from "@magentic/policy";
import {
  AgentInfo,
  AgentRequest,
  Api,
  CompactionFailed,
  Conversation,
  ConversationNotFound,
  RunDenied,
  RunNotFound,
  type RunRequest,
  type SteerRequest,
} from "@magentic/protocol";
import { Config, DateTime, Effect, Option, Stream } from "effect";

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

/** Every RPC the gateway answers. Needs the runner, the registries, the MCP standings, and identity, policy, and audit. */
export const RpcHandlers = Api.toLayer(
  Effect.gen(function* () {
    const host = yield* PluginHost;
    const registry = yield* AgentRegistry;
    const models = yield* ModelRegistry;
    const runner = yield* Runner;
    const store = yield* ConversationStore;
    const caller = callerVia(yield* Identity);
    const policy = yield* Policy;
    const audit = yield* Audit;
    const mcp = yield* McpServers;
    const steering = yield* Steering;

    /** What a surface may know, with the model the agent would run on today. */
    const toInfo = Effect.fn("Gateway.toInfo")(function* (agent: AgentDefinition) {
      const resolved = yield* models.resolve(Option.fromNullishOr(agent.model)).pipe(Effect.option);
      const base = { name: agent.name, description: agent.description, tools: agent.tools };
      return new AgentInfo(Option.isSome(resolved) ? { ...base, model: resolved.value.ref } : base);
    });

    const run = Effect.fn("Gateway.run")(function* (name: string, payload: RunRequest) {
      const { input, attachments, conversationId, model, directory, reasoning } = payload;
      const agent = yield* registry.get(name);
      const principal = yield* caller;
      // Continuing a conversation means one of the caller's own. An unknown id starts one.
      if (conversationId !== undefined) {
        const found = yield* store.get(conversationId);
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
        reasoning: Option.fromNullishOr(reasoning),
      });
    });

    /** More for one of the caller's runs in flight; a run that is not theirs is not found. */
    const steer = Effect.fn("Gateway.steer")(function* (payload: SteerRequest) {
      const principal = yield* caller;
      const accepted = yield* steering.offer(payload.runId, principal.id, {
        input: payload.input,
        attachments: payload.attachments ?? [],
      });
      if (!accepted) {
        return yield* new RunNotFound({ runId: payload.runId });
      }
    });

    const unsteer = Effect.fn("Gateway.unsteer")(function* (runId: string) {
      const principal = yield* caller;
      const taken = yield* steering.retract(runId, principal.id);
      return taken.map((s) => s.input);
    });

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

    const rename = Effect.fn("Gateway.conversations.rename")(function* (id: string, title: string) {
      const principal = yield* caller;
      const info = yield* owned(store, principal.id, id);
      const renamed = new Conversation({ ...info, title });
      yield* store.update(renamed).pipe(Effect.orDie);
      return renamed;
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

    return Api.of({
      health: () => Effect.void,
      listAgents: () => registry.list.pipe(Effect.flatMap(Effect.forEach(toInfo))),
      getAgent: ({ name }) => registry.get(name).pipe(Effect.flatMap(toInfo)),
      run: ({ agent, ...request }) => Stream.unwrap(run(agent, request)),
      steer: (request) => steer(request),
      unsteer: ({ runId }) => unsteer(runId),
      listConversations: ({ agent, directory }) => list(agent, directory),
      getConversation: ({ id }) => Effect.flatMap(caller, (p) => owned(store, p.id, id)),
      transcript: ({ id }) => transcript(id),
      rename: ({ id, title }) => rename(id, title),
      removeConversation: ({ id }) => remove(id),
      compact: ({ id }) => compact(id),
      listPlugins: () => host.plugins,
      listMcpServers: () => mcp.list,
    });
  }),
);
