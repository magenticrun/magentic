import type { Capability } from "@magentic/protocol";
import { Context } from "effect";
import type { Tool } from "effect/unstable/ai";

/**
 * Tool annotation carrying the capability policy evaluates for that tool.
 * The registry refuses a tool that leaves it at `"none"`.
 */
export const CapabilityAnnotation = Context.Reference<Capability | "none">(
  "magentic/plugin/Capability",
  { defaultValue: () => "none" },
);

export const capabilityOf = (tool: Tool.Any): Capability | "none" =>
  Context.get(tool.annotations, CapabilityAnnotation);
