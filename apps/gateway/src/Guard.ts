import { Audit, AuditEvent } from "@magentic/audit";
import { ToolCallGuard } from "@magentic/core";
import { Policy } from "@magentic/policy";
import type { ToolCallRequest } from "@magentic/protocol";
import { DateTime, Effect, Layer } from "effect";

/**
 * Policy decides every tool call and audit records how it went. Wired here,
 * in the gateway, so no plugin can register around it.
 */
export const ToolCallGuardLive = Layer.effect(
  ToolCallGuard,
  Effect.gen(function* () {
    const policy = yield* Policy;
    const audit = yield* Audit;

    const record = (call: ToolCallRequest, action: string, reason?: string) =>
      Effect.flatMap(DateTime.now, (at) => {
        const base = {
          runId: call.runId,
          callId: call.callId,
          agent: call.agent,
          tool: call.tool,
          capability: call.capability,
        };
        const detail = reason === undefined ? base : { ...base, reason };
        return audit.record(new AuditEvent({ at, principal: call.principal, action, detail }));
      });

    const before = Effect.fn("ToolCallGuard.before")(function* (call: ToolCallRequest) {
      const decision = yield* policy.evaluateToolCall(call);
      if (decision._tag === "Allow") {
        return { _tag: "Allow" as const };
      }
      // Approvals arrive with the durable workflow engine; until then a required approval is a denial.
      yield* record(call, "tool.denied", decision.reason);
      return { _tag: "Deny" as const, reason: decision.reason };
    });

    return ToolCallGuard.of({
      before,
      after: (call, outcome) => record(call, outcome.isFailure ? "tool.failed" : "tool.called"),
    });
  }),
);
