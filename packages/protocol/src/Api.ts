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
import {
  Compacted,
  FollowRequest,
  RunDenied,
  RunEvent,
  RunNotFound,
  RunRequest,
  SteerRequest,
} from "./Run.ts";
import { BackgroundTask } from "./Task.ts";

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
  /**
   * Send more to a run in flight. The model sees it at its next call, before
   * it speaks again; `Steered` on the run's stream says when.
   */
  Rpc.make("steer", { payload: SteerRequest.fields, error: RunNotFound }),
  /** Take back what was steered but has not reached the model yet; the inputs, oldest first. */
  Rpc.make("unsteer", { payload: { runId: Schema.String }, success: Schema.Array(Schema.String) }),
  /**
   * The runs the gateway starts on its own in the conversation, streamed as
   * they happen. While a surface follows, a notice that lands between runs
   * (a background task's end, for one) starts a run at once, as Claude Code
   * re-invokes the model, rather than waiting for the next input; those
   * runs take steering like any other. Following ends when the surface
   * stops reading; nobody following, notices wait for the next input.
   */
  Rpc.make("follow", {
    payload: FollowRequest.fields,
    success: RunEvent,
    error: Schema.Union([AgentNotFound, RunDenied, ConversationNotFound]),
    stream: true,
  }),
  /** Stop a run the gateway started; one the surface started ends when the surface stops reading it. */
  Rpc.make("stopRun", { payload: { runId: Schema.String }, error: RunNotFound }),
  /** The caller's background tasks, oldest first, running or ended; of one conversation when asked. */
  Rpc.make("listTasks", {
    payload: { conversationId: Schema.optional(ConversationId) },
    success: Schema.Array(BackgroundTask),
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
