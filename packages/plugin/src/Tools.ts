import type { Principal } from "@magentic/protocol";
import { Context, type Effect, type Schema, type Scope } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";
import type { PluginSetupError, Registration } from "./Plugin.ts";

/** Services a toolkit's handlers and result codecs need at call time. */
export type ToolServices<Tools extends Record<string, Tool.Any>> =
  | Tool.HandlerServices<Tools[keyof Tools]>
  | Tool.ResultDecodingServices<Tools[keyof Tools]>;

/**
 * Whether an entry of an agent's `tools` list names a tool. An entry ending in
 * `*` matches every tool with that prefix, so `linear_*` takes every tool an
 * MCP server called `linear` contributes.
 */
export const toolMatches = (pattern: string, name: string): boolean =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/** Who is calling, from which run. Provided to every tool handler per call. */
export class ToolCallContext extends Context.Service<
  ToolCallContext,
  {
    readonly runId: string;
    readonly callId: string;
    readonly agent: string;
    readonly principal: Principal;
  }
>()("magentic/plugin/ToolCallContext") {}

/** What a hook sees before a tool runs. Reassign `params` to rewrite, call `deny` to stop. */
export interface ToolCallBefore {
  readonly tool: string;
  readonly call: ToolCallContext["Service"];
  params: Schema.Json;
  deny(reason: string): void;
}

/** What a hook sees after a tool ran. Reassign `result` to rewrite what the model sees. */
export interface ToolCallAfter {
  readonly tool: string;
  readonly call: ToolCallContext["Service"];
  readonly params: Schema.Json;
  result: Schema.Json;
  readonly isFailure: boolean;
}

export interface ToolHooks {
  readonly "execute.before": ToolCallBefore;
  readonly "execute.after": ToolCallAfter;
}

export interface ToolDomain {
  /**
   * Contribute every tool of a toolkit that already has handlers. The
   * handlers' services are captured now and provided back on every call.
   * Fails when a tool has no capability or its name is already taken.
   */
  registerToolkit<Tools extends Record<string, Tool.Any>>(
    toolkit: Toolkit.WithHandler<Tools>,
  ): Effect.Effect<
    Registration,
    PluginSetupError,
    Scope.Scope | Exclude<ToolServices<Tools>, ToolCallContext>
  >;
  /** Intercept tool calls. Hooks run in plugin order; later hooks see earlier edits. */
  hook<Name extends keyof ToolHooks>(
    name: Name,
    handler: (event: ToolHooks[Name]) => Effect.Effect<void>,
  ): Effect.Effect<Registration, never, Scope.Scope>;
}
