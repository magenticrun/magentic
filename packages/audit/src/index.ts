import { Principal } from "@magentic/protocol";
import { Context, Effect, Layer, Ref, Schema } from "effect";

export class AuditEvent extends Schema.Class<AuditEvent>("magentic/audit/AuditEvent")({
  at: Schema.DateTimeUtc,
  principal: Principal,
  action: Schema.NonEmptyString,
  detail: Schema.optional(Schema.Unknown),
}) {}

/** Backing store for the in-memory sink, exposed so tests can inspect what was recorded. */
export class AuditMemory extends Context.Service<AuditMemory, Ref.Ref<ReadonlyArray<AuditEvent>>>()(
  "magentic/audit/AuditMemory",
) {
  static readonly layer = Layer.effect(AuditMemory, Ref.make<ReadonlyArray<AuditEvent>>([]));
}

export class Audit extends Context.Service<
  Audit,
  {
    record(event: AuditEvent): Effect.Effect<void>;
  }
>()("magentic/audit/Audit") {
  /** Keeps events in memory. Fine for tests and local runs, not for deployments. */
  static readonly layerMemory = Layer.effect(
    Audit,
    Effect.gen(function* () {
      const store = yield* AuditMemory;
      const record = Effect.fn("Audit.record")(function* (event: AuditEvent) {
        yield* Ref.update(store, (events) => [...events, event]);
      });
      return Audit.of({ record });
    }),
  ).pipe(Layer.provideMerge(AuditMemory.layer));
}
