import { Audit, AuditEvent } from "@magentic/audit";
import {
  AgentRegistry,
  BridgeBackend,
  type BridgeRunner,
  ConversationStore,
  Runner,
  Steering,
} from "@magentic/core";
import { type BridgePerson, Notices } from "@magentic/plugin";
import { Policy } from "@magentic/policy";
import { AgentRequest, Principal, RunDenied } from "@magentic/protocol";
import { DateTime, Effect, Layer, Option, Ref, Stream } from "effect";

/**
 * The gateway's side of a bridge: the one place a plugin's word on who
 * spoke becomes a principal. The subject is the machine principal
 * `system:bridge/<surface>`, the person is `onBehalfOf` as
 * `<provider>:<id>`, the groups are the plugin's prefixed with the surface,
 * and policy admits or denies the run as it would one from the CLI. The
 * conversation belongs to the subject, so every mention on a thread shares
 * it while "the caller's own conversations" stays true for people.
 */
const principalFor = (surface: string, provider: string, person: BridgePerson): Principal =>
  new Principal({
    id: `system:bridge/${surface}`,
    displayName: `${surface} bridge`,
    groups: person.groups.map((group) => `${surface}:${group}`),
    provider,
    onBehalfOf: { id: `${provider}:${person.id}`, displayName: person.displayName },
  });

/** Connects the bridge back-end the host holds; needs the runner and what admits a run. */
export const BridgesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* BridgeBackend;
    const registry = yield* AgentRegistry;
    const runner = yield* Runner;
    const store = yield* ConversationStore;
    const policy = yield* Policy;
    const audit = yield* Audit;
    const steering = yield* Steering;
    const notices = yield* Notices;
    /** The run in flight on each conversation a bridge started one on, for steering. */
    const live = yield* Ref.make(
      new Map<string, { readonly runId: string; readonly agent: string }>(),
    );

    const admit = Effect.fn("Bridges.admit")(function* (
      surface: string,
      agentName: string,
      principal: Principal,
      input: string,
    ) {
      const agent = yield* registry.get(agentName);
      const request = new AgentRequest({
        id: crypto.randomUUID(),
        agent: agent.name,
        surface,
        principal,
        input,
        createdAt: yield* DateTime.now,
      });
      const decision = yield* policy.evaluate(request);
      if (decision._tag !== "Allow") {
        yield* audit.record(
          new AuditEvent({
            at: request.createdAt,
            principal,
            action: "run.denied",
            detail: { requestId: request.id, agent: agent.name, surface, reason: decision.reason },
          }),
        );
        return yield* new RunDenied({ agent: agent.name, reason: decision.reason });
      }
      return { agent, request };
    });

    const forget = (conversationId: string, runId: string) =>
      Ref.update(live, (all) => {
        if (all.get(conversationId)?.runId !== runId) {
          return all;
        }
        const next = new Map(all);
        next.delete(conversationId);
        return next;
      });

    const bridges: BridgeRunner = {
      run: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const principal = principalFor(options.surface, options.provider, options.onBehalfOf);
            const { agent, request } = yield* admit(
              options.surface,
              options.agent,
              principal,
              options.input,
            );
            // The thread's conversation is the bridge's; one with the same key that is not is left alone.
            const found = yield* store.get(options.conversationId);
            if (Option.isSome(found) && found.value.principal !== principal.id) {
              return yield* new RunDenied({
                agent: agent.name,
                reason: `conversation ${options.conversationId} belongs to another principal`,
              });
            }
            yield* audit.record(
              new AuditEvent({
                at: request.createdAt,
                principal,
                action: "run.started",
                detail: {
                  requestId: request.id,
                  agent: agent.name,
                  surface: options.surface,
                  conversationId: options.conversationId,
                },
              }),
            );
            const started = yield* Ref.make(Option.none<string>());
            return runner
              .run({
                agent,
                principal,
                input: options.input,
                attachments: options.attachments ?? [],
                conversationId: Option.some(options.conversationId),
                model: Option.none(),
                directory: Option.fromNullishOr(options.directory),
                reasoning: Option.none(),
              })
              .pipe(
                Stream.tap((event) =>
                  event._tag === "RunStarted"
                    ? Ref.set(started, Option.some(event.runId)).pipe(
                        Effect.andThen(
                          Ref.update(live, (all) =>
                            new Map(all).set(options.conversationId, {
                              runId: event.runId,
                              agent: agent.name,
                            }),
                          ),
                        ),
                      )
                    : Effect.void,
                ),
                Stream.ensuring(
                  Effect.flatMap(Ref.get(started), (runId) =>
                    Option.isSome(runId)
                      ? forget(options.conversationId, runId.value)
                      : Effect.void,
                  ),
                ),
              );
          }),
        ),
      steer: Effect.fn("Bridges.steer")(function* (options) {
        const running = (yield* Ref.get(live)).get(options.conversationId);
        if (running === undefined) {
          return false;
        }
        const principal = principalFor(options.surface, options.provider, options.onBehalfOf);
        yield* admit(options.surface, running.agent, principal, options.input);
        return yield* steering.offer(running.runId, principal.id, {
          input: options.input,
          attachments: [],
        });
      }),
      notice: (conversationId, text) => notices.post(conversationId, text),
    };

    yield* backend.connect(bridges);
  }),
);
