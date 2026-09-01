import { assert, layer } from "@effect/vitest";
import { Principal } from "@magentic/protocol";
import { DateTime, Effect, Ref } from "effect";
import { Audit, AuditEvent, AuditMemory } from "./index.ts";

const alice = new Principal({
  id: "local:alice",
  displayName: "alice",
  groups: [],
  provider: "local",
});

layer(Audit.layerMemory)("Audit", (it) => {
  it.effect("records events in order", () =>
    Effect.gen(function* () {
      const audit = yield* Audit;
      const now = yield* DateTime.now;
      yield* audit.record(new AuditEvent({ at: now, principal: alice, action: "agent.invoke" }));
      const events = yield* Ref.get(yield* AuditMemory);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.action, "agent.invoke");
    }),
  );
});
