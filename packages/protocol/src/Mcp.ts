import { Schema } from "effect";

/**
 * Where a server stands. `failed` covers an entry that does not decode and a
 * handshake that did not complete; `closed` is a server that connected and
 * then went away, its tools withdrawn.
 */
export const McpServerStatus = Schema.Literals(["connected", "failed", "disabled", "closed"]);
export type McpServerStatus = typeof McpServerStatus.Type;

/** What `/mcp` shows: one row per server named under `mcp:` in `magentic.yaml`. */
export class McpServerInfo extends Schema.Class<McpServerInfo>("magentic/protocol/McpServerInfo")({
  name: Schema.NonEmptyString,
  status: McpServerStatus,
  /** The command line or the URL, when the entry decoded. */
  target: Schema.optional(Schema.String),
  /** Why it failed or closed, or what went wrong listing its tools. */
  error: Schema.optional(Schema.String),
  /** The tools it offers right now, as registered: `<server>_<tool>`. */
  tools: Schema.Array(Schema.String),
}) {}
