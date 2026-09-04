import { Audit, AuditEvent } from "@magentic/audit";
import {
  type AgentDefinition,
  ConversationStore,
  INTERRUPTED_REASON,
  Runner,
} from "@magentic/core";
import { Notices } from "@magentic/plugin";
import type { FollowEvent, Principal, RunEvent } from "@magentic/protocol";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Scope,
  Stream,
} from "effect";

/**
 * How often a follow says it is still there. The stream is silent between
 * the runs the gateway starts on its own, and a response that carries
 * nothing for five minutes is dropped by the client's fetch; a proxy in
 * front of the gateway gives up on one sooner, sixty seconds being the
 * common default. Well inside both, and cheap: one word every half minute.
 */
const KEEPALIVE = Duration.seconds(30);

/** What a follower asked for: the runs go to whoever follows, on this agent, as this principal. */
export interface FollowOptions {
  readonly conversationId: string;
  readonly agent: AgentDefinition;
  readonly principal: Principal;
  /** How hard the model should think in the runs started here; none for its default. */
  readonly reasoning: Option.Option<string>;
}

interface Followed {
  /** Surfaces following; the entry goes when the last leaves. */
  readonly followers: number;
  /** What the runs are started as: the latest follower's ask. */
  readonly options: FollowOptions;
  /** The wake-up queued or in flight, by its token; none when there is none. */
  readonly wake: Option.Option<string>;
  /** Whether that wake-up has started speaking, so a notice landing now may slip past its last check. */
  readonly started: boolean;
  /** Whether to wake once more when the one in flight ends. */
  readonly again: boolean;
}

interface InFlight {
  readonly token: string;
  readonly principal: string;
}

interface Tagged {
  readonly conversationId: string;
  readonly event: RunEvent;
}

/**
 * Runs the gateway starts on its own, the way Claude Code re-invokes the
 * model when a background task ends after it has answered. A surface
 * follows a conversation; while one does, a notice that lands between runs
 * starts a run at once, and its events go to every follower. Nobody
 * following, the notice waits for the next input, as it would anyway: a
 * model call nobody asked for and nobody watches is not worth its cost.
 * At most one wake-up is queued or in flight per conversation; the runner
 * serialises it behind any run the person started, and one that finds the
 * notices already taken ends without a word.
 */
export class Wakeups extends Context.Service<
  Wakeups,
  {
    /** Follow the conversation until the stream is dropped; what lands meanwhile is spoken to at once. */
    follow(options: FollowOptions): Stream.Stream<FollowEvent>;
    /** Stop a run started here; false when there is none by that id, or it is not the principal's. */
    stop(runId: string, principal: string): Effect.Effect<boolean>;
  }
>()("magentic/gateway/Wakeups") {
  /** Needs the runner to start runs, the notices to hear of them, the store for the model, and audit. */
  static readonly layer = Layer.effect(
    Wakeups,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const runner = yield* Runner;
      const notices = yield* Notices;
      const store = yield* ConversationStore;
      const audit = yield* Audit;
      const followed = yield* Ref.make(new Map<string, Followed>());
      /** The fiber behind each wake-up token, for stopping it. */
      const fibers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>());
      /** Runs started here and not yet ended, by run id, for `stop`. */
      const inFlight = yield* Ref.make(new Map<string, InFlight>());
      const events = yield* PubSub.unbounded<Tagged>();

      const update = (conversationId: string, f: (entry: Followed) => Followed) =>
        Ref.update(followed, (all) => {
          const entry = all.get(conversationId);
          return entry === undefined ? all : new Map(all).set(conversationId, f(entry));
        });

      const forget = (runId: string) =>
        Ref.update(inFlight, (all) => {
          const next = new Map(all);
          next.delete(runId);
          return next;
        });

      /** One wake-up of the conversation, as its followers asked for, and what it emits to them. */
      const wakeOnce = (conversationId: string, token: string, options: FollowOptions) =>
        Effect.gen(function* () {
          const info = yield* store.get(conversationId);
          const runId = yield* Ref.make(Option.none<string>());
          const ended = yield* Ref.make(false);
          yield* runner
            .wake({
              agent: options.agent,
              principal: options.principal,
              conversationId,
              model: Option.flatMap(info, (c) => Option.fromNullishOr(c.model)),
              reasoning: options.reasoning,
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event._tag === "RunStarted") {
                    yield* Ref.set(runId, Option.some(event.runId));
                    yield* Ref.update(inFlight, (all) =>
                      new Map(all).set(event.runId, { token, principal: options.principal.id }),
                    );
                    yield* update(conversationId, (entry) => ({ ...entry, started: true }));
                    yield* audit.record(
                      new AuditEvent({
                        at: yield* DateTime.now,
                        principal: options.principal,
                        action: "run.woken",
                        detail: { runId: event.runId, conversationId, agent: options.agent.name },
                      }),
                    );
                  }
                  if (event._tag === "RunFinished" || event._tag === "RunFailed") {
                    yield* Ref.set(ended, true);
                  }
                  yield* PubSub.publish(events, { conversationId, event });
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning(`wake-up of conversation ${conversationId} failed`, cause),
              ),
              // A stop interrupts the fiber reading the run, so the end the
              // runner emits goes unread; the followers hear of it here.
              Effect.ensuring(
                Effect.gen(function* () {
                  const started = yield* Ref.get(runId);
                  if (Option.isSome(started)) {
                    yield* forget(started.value);
                    if (!(yield* Ref.get(ended))) {
                      yield* PubSub.publish(events, {
                        conversationId,
                        event: { _tag: "RunFinished", reason: INTERRUPTED_REASON },
                      });
                    }
                  }
                  yield* Ref.update(fibers, (all) => {
                    const next = new Map(all);
                    next.delete(token);
                    return next;
                  });
                  const again = yield* Ref.modify(
                    followed,
                    (all): [boolean, Map<string, Followed>] => {
                      const entry = all.get(conversationId);
                      if (entry === undefined || !Option.contains(entry.wake, token)) {
                        return [false, all];
                      }
                      return [
                        entry.again,
                        new Map(all).set(conversationId, {
                          ...entry,
                          wake: Option.none(),
                          started: false,
                          again: false,
                        }),
                      ];
                    },
                  );
                  if (again) {
                    yield* wake(conversationId);
                  }
                }),
              ),
            );
        });

      /** Queue a wake-up of the conversation, unless one is queued or in flight, or nobody follows it. */
      const wake: (conversationId: string) => Effect.Effect<void> = Effect.fn("Wakeups.wake")(
        function* (conversationId: string) {
          const token = crypto.randomUUID();
          const options = yield* Ref.modify(
            followed,
            (all): [Option.Option<FollowOptions>, Map<string, Followed>] => {
              const entry = all.get(conversationId);
              if (entry === undefined || Option.isSome(entry.wake)) {
                return [Option.none(), all];
              }
              return [
                Option.some(entry.options),
                new Map(all).set(conversationId, { ...entry, wake: Option.some(token) }),
              ];
            },
          );
          if (Option.isNone(options)) {
            return;
          }
          // The fiber waits to be on the books before it runs, so a wake-up
          // that ends at once still finds its own entry to clear.
          const gate = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkIn(
            Effect.andThen(Deferred.await(gate), wakeOnce(conversationId, token, options.value)),
            scope,
          );
          yield* Ref.update(fibers, (all) => new Map(all).set(token, fiber));
          yield* Deferred.succeed(gate, undefined);
        },
      );

      /** A notice landed: wake the conversation, or wake it again after the run in flight, which may have checked already. */
      const landed = (conversationId: string) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(followed)).get(conversationId);
          if (entry === undefined) {
            return;
          }
          if (Option.isNone(entry.wake)) {
            yield* wake(conversationId);
          } else if (entry.started) {
            yield* update(conversationId, (current) => ({ ...current, again: true }));
          }
        });
      yield* Effect.forkIn(Stream.runForEach(notices.posted, landed), scope);

      /** The last follower left: a wake-up not yet speaking is dropped; one speaking finishes and is saved. */
      const leave = (conversationId: string) =>
        Effect.gen(function* () {
          const dropped = yield* Ref.modify(
            followed,
            (all): [Option.Option<string>, Map<string, Followed>] => {
              const entry = all.get(conversationId);
              if (entry === undefined) {
                return [Option.none(), all];
              }
              if (entry.followers > 1) {
                return [
                  Option.none(),
                  new Map(all).set(conversationId, { ...entry, followers: entry.followers - 1 }),
                ];
              }
              const next = new Map(all);
              next.delete(conversationId);
              return [entry.started ? Option.none() : entry.wake, next];
            },
          );
          if (Option.isSome(dropped)) {
            const fiber = (yield* Ref.get(fibers)).get(dropped.value);
            if (fiber !== undefined) {
              yield* Fiber.interrupt(fiber);
            }
          }
        });

      const follow = (options: FollowOptions): Stream.Stream<FollowEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { conversationId } = options;
            // Subscribed before counted, so nothing a wake-up emits in between is missed.
            const subscription = yield* PubSub.subscribe(events);
            yield* Effect.acquireRelease(
              Ref.update(followed, (all) => {
                const entry = all.get(conversationId);
                return new Map(all).set(
                  conversationId,
                  entry === undefined
                    ? {
                        followers: 1,
                        options,
                        wake: Option.none(),
                        started: false,
                        again: false,
                      }
                    : { ...entry, followers: entry.followers + 1, options },
                );
              }),
              () => leave(conversationId),
            );
            // Whatever landed while nobody followed is spoken to now.
            yield* wake(conversationId);
            const runs = Stream.fromSubscription(subscription).pipe(
              Stream.filter((tagged) => tagged.conversationId === conversationId),
              Stream.map((tagged): FollowEvent => tagged.event),
            );
            // Neither side ever ends on its own: the subscription lives until
            // the follower stops reading, and the tick is what keeps the
            // connection carrying it from being dropped for saying nothing.
            return Stream.merge(
              runs,
              Stream.tick(KEEPALIVE).pipe(
                // `tick` fires at once, and a connection just made needs no
                // proof that it is alive; the first one it owes is an
                // interval away.
                Stream.drop(1),
                Stream.map((): FollowEvent => ({ _tag: "Keepalive" })),
              ),
            );
          }),
        );

      const stop = Effect.fn("Wakeups.stop")(function* (runId: string, principal: string) {
        const found = (yield* Ref.get(inFlight)).get(runId);
        if (found === undefined || found.principal !== principal) {
          return false;
        }
        const fiber = (yield* Ref.get(fibers)).get(found.token);
        if (fiber === undefined) {
          return false;
        }
        yield* Fiber.interrupt(fiber);
        return true;
      });

      return Wakeups.of({ follow, stop });
    }),
  );
}
