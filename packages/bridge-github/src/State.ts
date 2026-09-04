import { messageOf } from "@magentic/plugin";
import { Context, Effect, FileSystem, Option, Path, Ref, Schema, Semaphore } from "effect";

/**
 * What the bridge remembers across restarts, in one small file under the
 * data directory: the deliveries it has handled, since GitHub sends a
 * delivery again on redelivery and restarts are when that matters; when
 * each thread last ran, so the next input carries only the comments since;
 * the poller's watermark per repository; and when failed deliveries were
 * last swept.
 */
const Persisted = Schema.Struct({
  deliveries: Schema.Array(Schema.String),
  threads: Schema.Record(Schema.String, Schema.Struct({ lastRunAt: Schema.String })),
  polls: Schema.Record(Schema.String, Schema.Struct({ since: Schema.String })),
  lastSweepAt: Schema.optional(Schema.String),
});
type Persisted = typeof Persisted.Type;

const empty: Persisted = { deliveries: [], threads: {}, polls: {} };

/** Delivery ids kept; older ones cannot be redelivered by then anyway. */
const KEPT_DELIVERIES = 2_000;

export class BridgeState extends Context.Service<
  BridgeState,
  {
    /** Whether the delivery was handled before; records it either way. */
    seenDelivery(id: string): Effect.Effect<boolean>;
    threadRunAt(conversationId: string): Effect.Effect<Option.Option<string>>;
    markThreadRun(conversationId: string, at: string): Effect.Effect<void>;
    pollSince(repository: string): Effect.Effect<Option.Option<string>>;
    setPollSince(repository: string, since: string): Effect.Effect<void>;
    readonly lastSweepAt: Effect.Effect<Option.Option<string>>;
    setLastSweep(at: string): Effect.Effect<void>;
  }
>()("magentic/bridge-github/BridgeState") {
  /** The state in `file`, read now and written after every change. A file that cannot be read starts empty. */
  static readonly make = Effect.fn("BridgeState.make")(function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const loaded = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) {
        return empty;
      }
      const text = yield* fs.readFileString(file);
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Persisted))(text);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `github bridge: starting with empty state; ${file}: ${messageOf(error)}`,
        ).pipe(Effect.as(empty)),
      ),
    );
    const state = yield* Ref.make(loaded);
    const writing = yield* Semaphore.make(1);

    const save = writing.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        // Written beside and renamed over, as the conversation store does it:
        // a write cut short by a restart would read as no state at all, and
        // the bridge would forget which deliveries it has already answered.
        const staging = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        yield* fs
          .writeFileString(staging, JSON.stringify(current, null, 2), { mode: 0o600 })
          .pipe(Effect.andThen(fs.rename(staging, file)))
          .pipe(Effect.onError(() => fs.remove(staging).pipe(Effect.ignore)));
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`github bridge: cannot write ${file}: ${messageOf(error)}`),
        ),
      ),
    );

    const change = (f: (current: Persisted) => Persisted) =>
      Ref.update(state, f).pipe(Effect.andThen(save));

    return BridgeState.of({
      seenDelivery: (id) =>
        Effect.flatMap(
          Ref.modify(state, (current): [boolean, Persisted] => {
            if (current.deliveries.includes(id)) {
              return [true, current];
            }
            const deliveries = [...current.deliveries, id].slice(-KEPT_DELIVERIES);
            return [false, { ...current, deliveries }];
          }),
          (seen) => (seen ? Effect.succeed(true) : Effect.as(save, false)),
        ),
      threadRunAt: (conversationId) =>
        Effect.map(Ref.get(state), (current) =>
          Option.map(Option.fromNullishOr(current.threads[conversationId]), (t) => t.lastRunAt),
        ),
      markThreadRun: (conversationId, at) =>
        change((current) => ({
          ...current,
          threads: { ...current.threads, [conversationId]: { lastRunAt: at } },
        })),
      pollSince: (repository) =>
        Effect.map(Ref.get(state), (current) =>
          Option.map(Option.fromNullishOr(current.polls[repository]), (p) => p.since),
        ),
      setPollSince: (repository, since) =>
        change((current) => ({
          ...current,
          polls: { ...current.polls, [repository]: { since } },
        })),
      lastSweepAt: Effect.map(Ref.get(state), (current) =>
        Option.fromNullishOr(current.lastSweepAt),
      ),
      setLastSweep: (at) => change((current) => ({ ...current, lastSweepAt: at })),
    });
  });
}
