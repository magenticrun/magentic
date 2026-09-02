import type { Attachment } from "@magentic/protocol";
import { Context, Effect, Layer, Ref, type Scope } from "effect";

/** One input sent to a run in flight, waiting for the model's next call. */
export interface Steer {
  readonly input: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/** A run's side of its steering: what to take before each model call. */
export interface SteeringHandle {
  /** What has arrived since the last take, oldest first. */
  readonly take: Effect.Effect<ReadonlyArray<Steer>>;
  /**
   * The same, except that when nothing has arrived the run closes to
   * steering in the same step, so nothing can slip in between the check
   * and the end of the run.
   */
  readonly takeOrClose: Effect.Effect<ReadonlyArray<Steer>>;
}

interface Entry {
  /** Whose run it is; nobody else may steer it. */
  readonly principal: string;
  readonly pending: ReadonlyArray<Steer>;
}

/**
 * Where inputs for runs in flight wait. A run opens itself here when it
 * starts and takes what has arrived before each model call; the gateway
 * offers what surfaces send. A run that has ended, or was never here, takes
 * nothing, and an offer to it says so.
 */
export class Steering extends Context.Service<
  Steering,
  {
    /** Open a run to steering until the scope closes; the handle is the run's side. */
    open(runId: string, principal: string): Effect.Effect<SteeringHandle, never, Scope.Scope>;
    /** Hand an input to a run; false when no such run is open, or it is not the principal's. */
    offer(runId: string, principal: string, steer: Steer): Effect.Effect<boolean>;
    /** Take back what has not reached the model yet, oldest first; nothing for a run that is not open. */
    retract(runId: string, principal: string): Effect.Effect<ReadonlyArray<Steer>>;
  }
>()("magentic/core/Steering") {
  static readonly layer = Layer.effect(
    Steering,
    Effect.gen(function* () {
      // One map behind one Ref: every change is one `modify`, so an offer
      // and a close can never interleave.
      const runs = yield* Ref.make(new Map<string, Entry>());

      const remove = (runId: string) =>
        Ref.update(runs, (all) => {
          const next = new Map(all);
          next.delete(runId);
          return next;
        });

      /** Take the pending inputs of an open run, closing it when `closeIfEmpty` and there are none. */
      const drain = (runId: string, closeIfEmpty: boolean) =>
        Ref.modify(runs, (all): [ReadonlyArray<Steer>, Map<string, Entry>] => {
          const entry = all.get(runId);
          if (entry === undefined) {
            return [[], all];
          }
          const next = new Map(all);
          if (entry.pending.length === 0 && closeIfEmpty) {
            next.delete(runId);
          } else {
            next.set(runId, { ...entry, pending: [] });
          }
          return [entry.pending, next];
        });

      const open = Effect.fn("Steering.open")(function* (runId: string, principal: string) {
        yield* Ref.update(runs, (all) => new Map(all).set(runId, { principal, pending: [] }));
        yield* Effect.addFinalizer(() => remove(runId));
        const handle: SteeringHandle = {
          take: drain(runId, false),
          takeOrClose: drain(runId, true),
        };
        return handle;
      });

      const offer = (runId: string, principal: string, steer: Steer) =>
        Ref.modify(runs, (all): [boolean, Map<string, Entry>] => {
          const entry = all.get(runId);
          if (entry === undefined || entry.principal !== principal) {
            return [false, all];
          }
          return [true, new Map(all).set(runId, { ...entry, pending: [...entry.pending, steer] })];
        });

      const retract = (runId: string, principal: string) =>
        Ref.modify(runs, (all): [ReadonlyArray<Steer>, Map<string, Entry>] => {
          const entry = all.get(runId);
          if (entry === undefined || entry.principal !== principal) {
            return [[], all];
          }
          return [entry.pending, new Map(all).set(runId, { ...entry, pending: [] })];
        });

      return Steering.of({ open, offer, retract });
    }),
  );
}
