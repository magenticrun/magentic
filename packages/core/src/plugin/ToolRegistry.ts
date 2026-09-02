import {
  type AgentDefinition,
  type PluginSetupError,
  ToolCallContext,
  type ToolCallBefore,
  type ToolHooks,
} from "@magentic/plugin";
import { type Capability, type Principal, ToolCallRequest } from "@magentic/protocol";
import { Context, Effect, Layer, type Schema, Stream } from "effect";
import type { AiError, Tool, Toolkit } from "effect/unstable/ai";

/** Whether a tool call may proceed. `RequireApproval` is a deny until approvals exist. */
export type GuardDecision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: string };

/**
 * Wraps every tool call the registry hands out. The gateway implements it with
 * policy and audit; plugins cannot register around it.
 */
export class ToolCallGuard extends Context.Service<
  ToolCallGuard,
  {
    before(call: ToolCallRequest): Effect.Effect<GuardDecision>;
    after(call: ToolCallRequest, outcome: { readonly isFailure: boolean }): Effect.Effect<void>;
  }
>()("magentic/core/ToolCallGuard") {
  /** For tests and the embedded local gateway. */
  static readonly layerAllowAll = Layer.succeed(
    ToolCallGuard,
    ToolCallGuard.of({
      before: () => Effect.succeed({ _tag: "Allow" }),
      after: () => Effect.void,
    }),
  );
}

/** One registered tool with its handler bound to the services it was built with. */
export interface ToolEntry {
  readonly plugin: string;
  readonly tool: Tool.Any;
  readonly capability: Capability;
  readonly handle: (
    params: Schema.Json,
    callId: string,
  ) => Effect.Effect<
    Stream.Stream<Tool.HandlerResult<Tool.Any>, Tool.HandlerError<Tool.Any>, ToolCallContext>,
    AiError.AiError
  >;
}

export type ToolHookEntry = {
  [Name in keyof ToolHooks]: {
    readonly name: Name;
    readonly handler: (event: ToolHooks[Name]) => Effect.Effect<void>;
  };
}[keyof ToolHooks];

export interface ToolInfo {
  readonly name: string;
  readonly plugin: string;
  readonly capability: Capability;
  readonly description: string;
}

export interface RunIdentity {
  readonly runId: string;
  readonly principal: Principal;
}

export type AnyToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>;

/** The tools every plugin contributed, and the per-agent view the runner uses. */
export class ToolRegistry extends Context.Service<
  ToolRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ToolInfo>>;
    /**
     * The agent's tools with every call guarded: policy first, then the
     * `execute.before` hooks, the handler with a `ToolCallContext`, the
     * `execute.after` hooks, and audit.
     */
    forAgent(agent: AgentDefinition, run: RunIdentity): Effect.Effect<AnyToolkit>;
  }
>()("magentic/core/ToolRegistry") {}

export type ToolRegistrationFailure = PluginSetupError;

/** The result the model sees when a call never reached the tool. */
const refused = (tool: string, reason: string): Tool.HandlerResult<Tool.Any> => {
  const value = { _tag: "ToolCallRefused", tool, reason };
  return { result: value, encodedResult: value, isFailure: true, preliminary: false };
};

export interface ToolRegistryInputs {
  readonly entries: Effect.Effect<ReadonlyArray<ToolEntry>>;
  readonly hooks: Effect.Effect<ReadonlyArray<ToolHookEntry>>;
  readonly disabled: ReadonlySet<string>;
  readonly guard: ToolCallGuard["Service"];
}

/** Builds the registry service over the host's registries. */
export const toolRegistryOver = (inputs: ToolRegistryInputs): ToolRegistry["Service"] => {
  const visible = Effect.map(inputs.entries, (all) =>
    all.filter((entry) => !inputs.disabled.has(entry.tool.name)),
  );

  const list = Effect.map(visible, (all) =>
    all.map((entry) => ({
      name: entry.tool.name,
      plugin: entry.plugin,
      capability: entry.capability,
      description: entry.tool.description ?? "",
    })),
  );

  const forAgent = Effect.fn("ToolRegistry.forAgent")(function* (
    agent: AgentDefinition,
    run: RunIdentity,
  ) {
    const allowed = new Set(agent.tools);
    const entries = (yield* visible).filter((entry) => allowed.has(entry.tool.name));
    const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
    const tools = Object.fromEntries(entries.map((entry) => [entry.tool.name, entry.tool]));

    const handle = (name: string, params: Tool.ParametersEncoded<Tool.Any>, toolCallId?: string) =>
      Effect.gen(function* () {
        const entry = byName.get(name);
        if (entry === undefined) {
          return Stream.succeed(refused(name, `${name} is not available to ${agent.name}`));
        }
        const callId = toolCallId ?? crypto.randomUUID();
        const call: ToolCallContext["Service"] = {
          runId: run.runId,
          callId,
          agent: agent.name,
          principal: run.principal,
        };
        // SAFETY: encoded tool parameters are the JSON object the model sent.
        const jsonParams = params as Schema.Json;
        const request = new ToolCallRequest({
          runId: run.runId,
          callId,
          agent: agent.name,
          principal: run.principal,
          tool: name,
          capability: entry.capability,
          params: jsonParams,
        });

        const decision = yield* inputs.guard.before(request);
        if (decision._tag === "Deny") {
          return Stream.succeed(refused(name, decision.reason));
        }

        const hooks = yield* inputs.hooks;
        let denied: string | undefined;
        const before: ToolCallBefore = {
          tool: name,
          call,
          params: jsonParams,
          deny: (reason) => {
            denied = reason;
          },
        };
        for (const hook of hooks) {
          if (hook.name === "execute.before") {
            yield* hook.handler(before);
            if (denied !== undefined) {
              return Stream.succeed(refused(name, denied));
            }
          }
        }

        const afterHooks = hooks.flatMap((hook) => (hook.name === "execute.after" ? [hook] : []));
        const applyAfter = (result: Tool.HandlerResult<Tool.Any>) =>
          Effect.gen(function* () {
            if (result.preliminary || afterHooks.length === 0) {
              return result;
            }
            const event = {
              tool: name,
              call,
              params: before.params,
              // SAFETY: the encoded result is the JSON form the tool's success or failure schema produced.
              result: result.encodedResult as Schema.Json,
              isFailure: result.isFailure,
            };
            for (const hook of afterHooks) {
              yield* hook.handler(event);
            }
            return { ...result, encodedResult: event.result };
          });

        const stream = yield* entry
          .handle(before.params, callId)
          .pipe(Effect.provideService(ToolCallContext, call));
        return stream.pipe(
          Stream.provideService(ToolCallContext, call),
          Stream.mapEffect(applyAfter),
          Stream.tap((result) =>
            result.preliminary
              ? Effect.void
              : inputs.guard.after(request, { isFailure: result.isFailure }),
          ),
        );
      });

    const toolkit: AnyToolkit = { tools, handle };
    return toolkit;
  });

  return ToolRegistry.of({ list, forAgent });
};
