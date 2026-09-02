import { Schema } from "effect";

/**
 * Coarse label policy reasons about. Every tool declares exactly one, so rules
 * can say "shell needs approval" without enumerating tools.
 */
export const Capability = Schema.Literals(["fs:read", "fs:write", "shell", "http:egress"]);
export type Capability = typeof Capability.Type;
