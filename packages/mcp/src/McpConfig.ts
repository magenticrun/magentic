import { Schema } from "effect";

/** Milliseconds a connect or a tool call may take. */
const Timeout = Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)));

/** A server the gateway starts itself and talks to over stdio. */
export class LocalMcpServer extends Schema.Class<LocalMcpServer>("magentic/mcp/LocalMcpServer")({
  type: Schema.Literal("local"),
  /** The executable and its arguments, e.g. `[npx, -y, "@modelcontextprotocol/server-filesystem", .]`. */
  command: Schema.NonEmptyArray(Schema.String),
  /** Working directory, relative to the workspace. The workspace itself when omitted. */
  cwd: Schema.optional(Schema.String),
  /** Variables added to the safe default environment (PATH, HOME, and the like). */
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  timeout: Timeout,
}) {}

/** A server somewhere else, reached over Streamable HTTP, or SSE when that fails. */
export class RemoteMcpServer extends Schema.Class<RemoteMcpServer>("magentic/mcp/RemoteMcpServer")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  /** Sent with every request; where a bearer token goes. */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  timeout: Timeout,
}) {}

/** One entry under `mcp:` in `magentic.yaml`. */
export const McpServerConfig = Schema.Union([LocalMcpServer, RemoteMcpServer]);
export type McpServerConfig = typeof McpServerConfig.Type;

/** Milliseconds allowed for the handshake and for a tool call when the entry sets none. */
export const DEFAULT_TIMEOUT_MS = 30_000;
