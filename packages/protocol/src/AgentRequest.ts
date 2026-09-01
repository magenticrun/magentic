import { Schema } from "effect";
import { Principal, Surface } from "./Principal.ts";

/** A single inbound request to an agent, as the gateway sees it. */
export class AgentRequest extends Schema.Class<AgentRequest>("magentic/protocol/AgentRequest")({
  id: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  surface: Surface,
  principal: Principal,
  input: Schema.String,
  createdAt: Schema.DateTimeUtc,
}) {}
