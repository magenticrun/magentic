import type { Registration } from "@magentic/plugin";
import { Effect, Ref, type Scope } from "effect";

/** Which plugin registered something, and where it sits in the plugin order. */
export interface PluginRef {
  readonly id: string;
  readonly order: number;
}

export interface Entry<A> {
  readonly plugin: PluginRef;
  readonly seq: number;
  readonly value: A;
}

/**
 * An ordered set of things plugins registered. Order is plugin order, then
 * registration order within a plugin. A registration lives as long as the
 * scope it was made in, or until disposed.
 */
export interface Registry<A> {
  register(plugin: PluginRef, value: A): Effect.Effect<Registration, never, Scope.Scope>;
  readonly entries: Effect.Effect<ReadonlyArray<Entry<A>>>;
  readonly values: Effect.Effect<ReadonlyArray<A>>;
}

const byOrder = <A>(a: Entry<A>, b: Entry<A>) => a.plugin.order - b.plugin.order || a.seq - b.seq;

/** `onChange` runs after every registration and disposal, once the registry has settled. */
export const openRegistry = <A>(
  onChange: Effect.Effect<void> = Effect.void,
): Effect.Effect<Registry<A>> =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<Entry<A>>>([]);
    const counter = yield* Ref.make(0);

    const remove = (seq: number) =>
      Ref.modify(entries, (all) => {
        const next = all.filter((entry) => entry.seq !== seq);
        return [next.length !== all.length, next];
      });

    const register = Effect.fn("Registry.register")(function* (plugin: PluginRef, value: A) {
      const seq = yield* Ref.getAndUpdate(counter, (n) => n + 1);
      yield* Ref.update(entries, (all) => [...all, { plugin, seq, value }].toSorted(byOrder));
      yield* onChange;
      const dispose = Effect.gen(function* () {
        if (yield* remove(seq)) {
          yield* onChange;
        }
      });
      yield* Effect.addFinalizer(() => dispose);
      return { dispose };
    });

    return {
      register,
      entries: Ref.get(entries),
      values: Effect.map(Ref.get(entries), (all) => all.map((entry) => entry.value)),
    };
  });
