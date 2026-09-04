import { Audit, AuditEvent } from "@magentic/audit";
import {
  type AgentDefinition,
  AgentRegistry,
  ConversationStore,
  describeInterval,
  MAX_INTERVAL_MILLIS,
  MIN_INTERVAL_MILLIS,
  ModelRegistry,
  PluginHost,
  readSchedule,
  Runner,
  ScheduledTasks,
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
  type FollowRequest,
  RunDenied,
  RunNotFound,
  type MissedPolicy,
  type RunRequest,
  ReadScheduleResult,
  ScheduleInvalid,
  type ScheduleKind,
  ScheduleNotFound,
  type SteerRequest,
} from "@magentic/protocol";
import { BackgroundTasks } from "@magentic/tools";
import { Config, DateTime, Effect, Option, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { Wakeups } from "./Wakeups.ts";

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

/** Every RPC the gateway answers. Needs the runner and the wake-ups, the registries, the background tasks, the MCP standings, and identity, policy, and audit. */
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
    const wakeups = yield* Wakeups;
    const tasks = yield* BackgroundTasks;
    const schedules = yield* ScheduledTasks;

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

    /**
     * Follow one of the caller's conversations, or one about to be theirs:
     * a first run is saved when it ends, and the surface follows it as soon
     * as it hears the id. The policy is asked once here, as it is for a run.
     */
    const follow = Effect.fn("Gateway.follow")(function* (payload: FollowRequest) {
      const agent = yield* registry.get(payload.agent);
      const principal = yield* caller;
      const found = yield* store.get(payload.conversationId);
      if (Option.isSome(found) && found.value.principal !== principal.id) {
        return yield* new ConversationNotFound({ id: payload.conversationId });
      }
      const request = new AgentRequest({
        id: crypto.randomUUID(),
        agent: agent.name,
        surface: "cli",
        principal,
        input: "",
        createdAt: yield* DateTime.now,
      });
      const decision = yield* policy.evaluate(request);
      if (decision._tag !== "Allow") {
        return yield* new RunDenied({ agent: agent.name, reason: decision.reason });
      }
      return wakeups.follow({
        conversationId: payload.conversationId,
        agent,
        principal,
        reasoning: Option.fromNullishOr(payload.reasoning),
      });
    });

    const stopRun = Effect.fn("Gateway.stopRun")(function* (runId: string) {
      const principal = yield* caller;
      if (!(yield* wakeups.stop(runId, principal.id))) {
        return yield* new RunNotFound({ runId });
      }
    });

    const listTasks = Effect.fn("Gateway.listTasks")(function* (
      conversationId: string | undefined,
    ) {
      const principal = yield* caller;
      return yield* tasks.list(principal.id, Option.fromNullishOr(conversationId));
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

    /**
     * A conversation the caller owns, before it has run. The runner invents an
     * id at its first turn, which is too late for a schedule: `/loop` may be
     * the first thing typed. Writing what the conversation is, with no
     * history, is enough — the runner starts a fresh chat when it finds none.
     */
    const openConversation = Effect.fn("Gateway.conversations.open")(function* (
      name: string,
      directory: string | undefined,
    ) {
      const agent = yield* registry.get(name);
      const principal = yield* caller;
      const now = yield* DateTime.now;
      const info = new Conversation({
        id: crypto.randomUUID(),
        agent: agent.name,
        principal: principal.id,
        title: "New conversation",
        directory,
        createdAt: now,
        updatedAt: now,
        messages: 0,
      });
      yield* store.update(info).pipe(Effect.orDie);
      return info;
    });

    /**
     * The model reads what the person meant; the times are worked out here.
     * It runs on the agent's own model, as a compaction summary does, and it
     * is a call of its own rather than part of any turn — so the agent's
     * system prompt, which is the cache prefix of every turn, keeps no clock.
     */
    const readScheduleFor = Effect.fn("Gateway.schedules.read")(function* (
      name: string,
      text: string,
      zone: string,
    ) {
      const agent = yield* registry.get(name);
      const parsed = DateTime.zoneFromString(zone);
      if (Option.isNone(parsed)) {
        return yield* new ScheduleInvalid({ message: `${zone} is not a time zone` });
      }
      const model = yield* models
        .languageModel(Option.fromNullishOr(agent.model))
        .pipe(
          Effect.mapError(
            (error) =>
              new ScheduleInvalid({ message: `no model to read that with: ${error.message}` }),
          ),
        );
      const read = yield* readSchedule(text, parsed.value).pipe(
        Effect.provideService(LanguageModel.LanguageModel, model),
        Effect.mapError((error) => new ScheduleInvalid({ message: error.message })),
      );
      return new ReadScheduleResult({
        intervalMillis: read.intervalMillis,
        prompt: read.prompt,
        until: Option.getOrUndefined(read.until),
        interpretation: read.interpretation,
      });
    });

    const createSchedule = Effect.fn("Gateway.schedules.create")(function* (payload: {
      readonly conversationId: string;
      readonly kind: ScheduleKind;
      readonly prompt: string;
      readonly intervalMillis: number;
      readonly missed?: MissedPolicy | undefined;
      readonly expiresAt?: DateTime.Utc | undefined;
    }) {
      const principal = yield* caller;
      const info = yield* owned(store, principal.id, payload.conversationId);
      if (
        !Number.isFinite(payload.intervalMillis) ||
        payload.intervalMillis < MIN_INTERVAL_MILLIS
      ) {
        return yield* new ScheduleInvalid({
          message: `a loop runs at most once every ${describeInterval(MIN_INTERVAL_MILLIS)}`,
        });
      }
      if (payload.intervalMillis > MAX_INTERVAL_MILLIS) {
        return yield* new ScheduleInvalid({
          message: `a loop lives at most ${describeInterval(MAX_INTERVAL_MILLIS)}`,
        });
      }
      return yield* schedules
        .create({
          conversationId: payload.conversationId,
          agent: info.agent,
          kind: payload.kind,
          prompt: payload.prompt,
          intervalMillis: payload.intervalMillis,
          missed: payload.missed ?? "once",
          expiresAt: Option.fromNullishOr(payload.expiresAt),
        })
        .pipe(Effect.mapError((error) => new ScheduleInvalid({ message: error.message })));
    });

    const listSchedules = Effect.fn("Gateway.schedules.list")(function* (conversationId: string) {
      const principal = yield* caller;
      yield* owned(store, principal.id, conversationId);
      return yield* schedules.list(conversationId);
    });

    const deleteSchedule = Effect.fn("Gateway.schedules.delete")(function* (
      conversationId: string,
      id: string,
    ) {
      const principal = yield* caller;
      yield* owned(store, principal.id, conversationId);
      const stopped = yield* schedules
        .remove(conversationId, id)
        .pipe(Effect.orElseSucceed(() => false));
      if (!stopped) {
        return yield* new ScheduleNotFound({ id });
      }
    });

    return Api.of({
      health: () => Effect.void,
      listAgents: () => registry.list.pipe(Effect.flatMap(Effect.forEach(toInfo))),
      getAgent: ({ name }) => registry.get(name).pipe(Effect.flatMap(toInfo)),
      run: ({ agent, ...request }) => Stream.unwrap(run(agent, request)),
      steer: (request) => steer(request),
      unsteer: ({ runId }) => unsteer(runId),
      follow: (request) => Stream.unwrap(follow(request)),
      stopRun: ({ runId }) => stopRun(runId),
      listTasks: ({ conversationId }) => listTasks(conversationId),
      listConversations: ({ agent, directory }) => list(agent, directory),
      getConversation: ({ id }) => Effect.flatMap(caller, (p) => owned(store, p.id, id)),
      transcript: ({ id }) => transcript(id),
      rename: ({ id, title }) => rename(id, title),
      removeConversation: ({ id }) => remove(id),
      compact: ({ id }) => compact(id),
      listPlugins: () => host.plugins,
      listMcpServers: () => mcp.list,
      openConversation: ({ agent, directory }) => openConversation(agent, directory),
      readSchedule: ({ agent, text, zone }) => readScheduleFor(agent, text, zone),
      createSchedule: (payload) => createSchedule(payload),
      listSchedules: ({ conversationId }) => listSchedules(conversationId),
      deleteSchedule: ({ conversationId, id }) => deleteSchedule(conversationId, id),
    });
  }),
);
