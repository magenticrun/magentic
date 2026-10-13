import {
  type AgentDefinition,
  type PluginSetupError,
  ToolCallContext,
  type ToolCallBefore,
  type ToolHooks,
  toolMatches,
} from "@magentic/plugin";
import {
  type Capability,
  type Principal,
  ToolCallRequest,
  TRACE_KIND,
  TRACE_RUN,
} from "@magentic/protocol";
import { Context, Deferred, Effect, Hash, Layer, Predicate, type Schema, Stream } from "effect";
import type { AiError, Tool, Toolkit } from "effect/ai";

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
    Stream.Stream<
      Tool.HandlerResult<Tool.Any>,
      Tool.HandlerError<Tool.Any> | AiError.AiError,
      ToolCallContext
    >,
    AiError.AiError,
    ToolCallContext
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
  readonly conversationId: string;
  readonly principal: Principal;
}

export type AnyToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>;

/** The tools every plugin contributed, and the per-agent view the runner uses. */
export class ToolRegistry extends Context.Service<
  ToolRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ToolInfo>>;
    /**
     * Waits for tools plugins said were still arriving at boot, such as an
     * MCP server's. Whether it had to wait: what the agents were built from
     * may have changed meanwhile.
     */
    readonly settle: Effect.Effect<boolean>;
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

/**
 * Identical calls, with the identical result, one run makes of a tool before
 * the model is told it is going round in circles, as opencode and Hermes
 * both catch a doom loop at the third.
 */
export const REPEAT_LIMIT = 3;

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** How much of a failed call's result its span keeps: enough to tell one failure from another. */
const FAILURE_LENGTH = 300;

/** A failed call's result as its span keeps it: its message when it has one, shortened. */
const failureText = (encoded: Schema.Json): string => {
  const message = isJsonObject(encoded) ? encoded["message"] : undefined;
  const text = Predicate.isString(encoded)
    ? encoded
    : Predicate.isString(message)
      ? message
      : JSON.stringify(encoded);
  return text.length > FAILURE_LENGTH ? `${text.slice(0, FAILURE_LENGTH)}…` : text;
};

/** JSON with object keys in order, so the same arguments always read the same. */
const canonical = (value: Schema.Json): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** The result the model sees, with a word from the harness beside it. */
const withNotice = (result: Schema.Json, notice: string): Schema.Json =>
  isJsonObject(result) ? { ...result, harnessNotice: notice } : { result, harnessNotice: notice };

export interface ToolRegistryInputs {
  readonly entries: Effect.Effect<ReadonlyArray<ToolEntry>>;
  readonly hooks: Effect.Effect<ReadonlyArray<ToolHookEntry>>;
  readonly disabled: ReadonlySet<string>;
  readonly guard: ToolCallGuard["Service"];
  /** Completed once every plugin's arriving tools have come or stopped being waited for. */
  readonly settled: Deferred.Deferred<void>;
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
    const entries = (yield* visible).filter((entry) =>
      agent.tools.some((pattern) =>
        toolMatches(pattern, { name: entry.tool.name, capability: entry.capability }),
      ),
    );
    const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
    const tools = Object.fromEntries(entries.map((entry) => [entry.tool.name, entry.tool]));
    /** How often this run has made each call and got each result, by a hash of all three. */
    const repeats = new Map<number, number>();

    const handle = Effect.fn("ToolRegistry.handle")(function* (
      name: string,
      params: Tool.ParametersEncoded<Tool.Any>,
      toolCallId?: string,
    ) {
      const callId = toolCallId ?? crypto.randomUUID();
      const entry = byName.get(name);
      /**
       * The call as a span of its own, from the guard's answer until the
       * result is in; a call turned away before the tool ran says why.
       */
      const traced = <A, E, R>(stream: Stream.Stream<A, E, R>, refusal?: string) =>
        stream.pipe(
          Stream.withSpan(`execute_tool ${name}`, {
            attributes: {
              [TRACE_KIND]: "tool",
              [TRACE_RUN]: run.runId,
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": name,
              "gen_ai.tool.call.id": callId,
              "magentic.capability": entry?.capability,
              "magentic.tool.refused": refusal,
            },
          }),
        );
      const refuse = (reason: string) => traced(Stream.succeed(refused(name, reason)), reason);
      if (entry === undefined) {
        return refuse(`${name} is not available to ${agent.name}`);
      }
      const call: ToolCallContext["Service"] = {
        runId: run.runId,
        conversationId: run.conversationId,
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
        return refuse(decision.reason);
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
            return refuse(denied);
          }
        }
      }

      const afterHooks = hooks.flatMap((hook) => (hook.name === "execute.after" ? [hook] : []));
      /**
       * The same call answered the same way again and again is a model that
       * is stuck, not one making progress; it hears so in the result, and the
       * call still runs, since the repeat may be on purpose (a poll).
       */
      const noticeRepeats = (result: Tool.HandlerResult<Tool.Any>) => {
        if (result.preliminary) {
          return result;
        }
        // SAFETY: the encoded result is the JSON form the tool's success or failure schema produced.
        const encoded = result.encodedResult as Schema.Json;
        const key = Hash.string(
          `${name}\u0000${canonical(before.params)}\u0000${canonical(encoded)}`,
        );
        const seen = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, seen);
        if (seen < REPEAT_LIMIT) {
          return result;
        }
        const notice =
          `This exact ${name} call has now been made ${seen} times in this run, with the same result each time. ` +
          "Repeating it will not change the outcome: try a different approach, or stop and say what is in the way.";
        return { ...result, encodedResult: withNotice(encoded, notice) };
      };

      const applyAfter = Effect.fnUntraced(function* (result: Tool.HandlerResult<Tool.Any>) {
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
      return traced(
        stream.pipe(
          Stream.provideService(ToolCallContext, call),
          Stream.mapEffect(applyAfter),
          Stream.map(noticeRepeats),
          Stream.tap((result) =>
            result.preliminary
              ? Effect.void
              : Effect.andThen(
                  Effect.annotateCurrentSpan({
                    "magentic.tool.failed": result.isFailure,
                    // SAFETY: the encoded result is the JSON form the tool's success or failure schema produced.
                    "magentic.tool.error": result.isFailure
                      ? failureText(result.encodedResult as Schema.Json)
                      : undefined,
                  }),
                  inputs.guard.after(request, { isFailure: result.isFailure }),
                ),
          ),
        ),
      );
    });

    const toolkit: AnyToolkit = { tools, handle };
    return toolkit;
  });

  const settle = Effect.gen(function* () {
    if (yield* Deferred.isDone(inputs.settled)) {
      return false;
    }
    yield* Deferred.await(inputs.settled);
    return true;
  });

  return ToolRegistry.of({ list, settle, forAgent });
};
