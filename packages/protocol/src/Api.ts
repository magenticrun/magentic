import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { AgentInfo, AgentNotFound } from "./Agent.ts";
import {
  CompactionFailed,
  Conversation,
  ConversationNotFound,
  TranscriptEntry,
} from "./Conversation.ts";
import { ConversationId } from "./ConversationId.ts";
import { McpServerInfo } from "./Mcp.ts";
import { PluginInfo } from "./Plugin.ts";
import { Compacted, RunDenied, RunEvent, RunRequest } from "./Run.ts";

// The API definition lives here, apart from the gateway, so surfaces derive
// typed clients from it without pulling in server code. It is Effect RPC over
// HTTP at `/rpc`, not a REST API: every surface we ship is TypeScript and
// imports this package, the run is a stream, and nothing here needs a URL.

/** Everything a surface can ask the gateway. Conversations are the caller's own; another person's are not found. */
export const Api = RpcGroup.make(
  Rpc.make("health"),
  Rpc.make("listAgents", { success: Schema.Array(AgentInfo) }),
  Rpc.make("getAgent", {
    payload: { name: Schema.String },
    success: AgentInfo,
    error: AgentNotFound,
  }),
  /** Ask an agent to handle one input; the events stream back until the run ends. */
  Rpc.make("run", {
    payload: { agent: Schema.String, ...RunRequest.fields },
    success: RunEvent,
    error: Schema.Union([AgentNotFound, RunDenied, ConversationNotFound]),
    stream: true,
  }),
  /** The caller's conversations, newest first, of one agent or directory when asked. */
  Rpc.make("listConversations", {
    payload: {
      agent: Schema.optional(Schema.String),
      directory: Schema.optional(Schema.String),
    },
    success: Schema.Array(Conversation),
  }),
  Rpc.make("getConversation", {
    payload: { id: ConversationId },
    success: Conversation,
    error: ConversationNotFound,
  }),
  Rpc.make("transcript", {
    payload: { id: ConversationId },
    success: Schema.Array(TranscriptEntry),
    error: ConversationNotFound,
  }),
  /** Give the conversation a title of the caller's choosing. */
  Rpc.make("rename", {
    payload: { id: ConversationId, title: Schema.NonEmptyString },
    success: Conversation,
    error: ConversationNotFound,
  }),
  Rpc.make("removeConversation", {
    payload: { id: ConversationId },
    error: ConversationNotFound,
  }),
  /** Fold the conversation so far into a summary the next run continues from. */
  Rpc.make("compact", {
    payload: { id: ConversationId },
    success: Compacted,
    error: Schema.Union([ConversationNotFound, CompactionFailed]),
  }),
  Rpc.make("listPlugins", { success: Schema.Array(PluginInfo) }),
  /** The MCP servers the gateway was configured with, whether or not they connected. */
  Rpc.make("listMcpServers", { success: Schema.Array(McpServerInfo) }),
);
export type Api = typeof Api;

/** Where the gateway serves the RPCs, under its base URL. */
export const RPC_PATH = "/rpc";
