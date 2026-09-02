import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { AgentInfo, AgentNotFound } from "./Agent.ts";
import {
  CompactionFailed,
  Conversation,
  ConversationNotFound,
  RenameRequest,
  TranscriptEntry,
} from "./Conversation.ts";
import { PluginInfo } from "./Plugin.ts";
import { Compacted, RunDenied, RunEvent, RunRequest } from "./Run.ts";

// The API definition lives here, apart from the gateway, so surfaces can derive
// typed clients from it without pulling in server code.

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
) {}

export class AgentsApi extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(AgentInfo) }),
    HttpApiEndpoint.get("get", "/:name", {
      params: { name: Schema.String },
      success: AgentInfo,
      error: AgentNotFound,
    }),
    HttpApiEndpoint.post("run", "/:name/runs", {
      params: { name: Schema.String },
      payload: RunRequest,
      success: HttpApiSchema.StreamSse({ data: RunEvent }),
      error: [AgentNotFound, RunDenied, ConversationNotFound],
    }),
  )
  .prefix("/agents")
  .annotateMerge(OpenApi.annotations({ title: "Agents" })) {}

/** The caller's conversations, newest first. Another person's are not found. */
export class ConversationsApi extends HttpApiGroup.make("conversations")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: { agent: Schema.optional(Schema.String), directory: Schema.optional(Schema.String) },
      success: Schema.Array(Conversation),
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: Conversation,
      error: ConversationNotFound,
    }),
    HttpApiEndpoint.get("transcript", "/:id/transcript", {
      params: { id: Schema.String },
      success: Schema.Array(TranscriptEntry),
      error: ConversationNotFound,
    }),
    /** Give the conversation a title of the caller's choosing. */
    HttpApiEndpoint.patch("rename", "/:id", {
      params: { id: Schema.String },
      payload: RenameRequest,
      success: Conversation,
      error: ConversationNotFound,
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: ConversationNotFound,
    }),
    /** Fold the conversation so far into a summary the next run continues from. */
    HttpApiEndpoint.post("compact", "/:id/compact", {
      params: { id: Schema.String },
      success: Compacted,
      error: [ConversationNotFound, CompactionFailed],
    }),
  )
  .prefix("/conversations")
  .annotateMerge(OpenApi.annotations({ title: "Conversations" })) {}

export class PluginsApi extends HttpApiGroup.make("plugins")
  .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(PluginInfo) }))
  .prefix("/plugins")
  .annotateMerge(OpenApi.annotations({ title: "Plugins" })) {}

export class Api extends HttpApi.make("magentic")
  .add(SystemApi)
  .add(AgentsApi)
  .add(ConversationsApi)
  .add(PluginsApi)
  .annotateMerge(OpenApi.annotations({ title: "magentic gateway" })) {}
