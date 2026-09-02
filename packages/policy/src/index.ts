import type { AgentRequest, ToolCallRequest } from "@magentic/protocol";
import { Context, Effect, Layer } from "effect";

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: string }
  | {
      readonly _tag: "RequireApproval";
      readonly reason: string;
      readonly approvers: ReadonlyArray<string>;
    };

/**
 * Every request passes through exactly one Policy before an agent sees it,
 * and every tool call passes through it again before the tool runs.
 */
export class Policy extends Context.Service<
  Policy,
  {
    evaluate(request: AgentRequest): Effect.Effect<Decision>;
    evaluateToolCall(call: ToolCallRequest): Effect.Effect<Decision>;
  }
>()("magentic/policy/Policy") {
  /** Permissive policy for local, single-user runs. Deployments replace this. */
  static readonly layerAllowAll = Layer.succeed(
    Policy,
    Policy.of({
      evaluate: () => Effect.succeed({ _tag: "Allow" }),
      evaluateToolCall: () => Effect.succeed({ _tag: "Allow" }),
    }),
  );
}
