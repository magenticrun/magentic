import { Schema } from "effect";
import { Capability } from "./Capability.ts";
import { Principal } from "./Principal.ts";

/** Where a plugin was loaded from. */
export const PluginSource = Schema.Literals(["builtin", "file", "package"]);
export type PluginSource = typeof PluginSource.Type;

export const PluginStatus = Schema.Literals(["active", "disabled", "failed"]);
export type PluginStatus = typeof PluginStatus.Type;

/** What `magentic plugin list` shows: one row per plugin the gateway knows about. */
export class PluginInfo extends Schema.Class<PluginInfo>("magentic/protocol/PluginInfo")({
  id: Schema.NonEmptyString,
  description: Schema.String,
  source: PluginSource,
  status: PluginStatus,
  /** Why setup failed, when it did. */
  error: Schema.optional(Schema.String),
  tools: Schema.Array(Schema.String),
  providers: Schema.Array(Schema.String),
  agents: Schema.Array(Schema.String),
}) {}

/** One tool call about to run, as policy sees it. */
export class ToolCallRequest extends Schema.Class<ToolCallRequest>(
  "magentic/protocol/ToolCallRequest",
)({
  runId: Schema.NonEmptyString,
  callId: Schema.String,
  agent: Schema.NonEmptyString,
  principal: Principal,
  tool: Schema.NonEmptyString,
  capability: Capability,
  params: Schema.Json,
}) {}
