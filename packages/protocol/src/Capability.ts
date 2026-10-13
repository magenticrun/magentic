import { Schema } from "effect";

/**
 * Coarse label policy reasons about. Every tool declares exactly one, so rules
 * can say "shell needs approval" without enumerating tools. `mcp` covers every
 * tool an MCP server contributes: the gateway cannot tell what such a tool does.
 * `forge:read` and `forge:write` are the tools a bridge brings for the code
 * host it knows (GitHub, GitLab): reading an issue or a pull request, and
 * commenting, pushing, and opening pull requests as the bot. `trace:read` is
 * reading how the calling conversation's own runs spent their time. `session:read`
 * is searching and reading the calling person's own earlier conversations.
 */
export const Capability = Schema.Literals([
  "fs:read",
  "fs:write",
  "shell",
  "http:egress",
  "browser:control",
  "browser:script",
  "mcp",
  "forge:read",
  "forge:write",
  "trace:read",
  "session:read",
]);
export type Capability = typeof Capability.Type;
