import { Schema } from "effect";

/**
 * Coarse label policy reasons about. Every tool declares exactly one, so rules
 * can say "shell needs approval" without enumerating tools. `mcp` covers every
 * tool an MCP server contributes: the gateway cannot tell what such a tool does.
 */
export const Capability = Schema.Literals(["fs:read", "fs:write", "shell", "http:egress", "mcp"]);
export type Capability = typeof Capability.Type;
