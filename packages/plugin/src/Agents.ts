import { type Effect, type Option, Schema, type Scope } from "effect";
import type { Registration } from "./Plugin.ts";

export class AgentDefinition extends Schema.Class<AgentDefinition>(
  "magentic/plugin/AgentDefinition",
)({
  /** Stable identifier used in routing and policy, e.g. "support-triage". */
  name: Schema.NonEmptyString,
  description: Schema.String,
  /** The system prompt every conversation with this agent starts from. */
  prompt: Schema.String,
  /** Tools this agent may request. Policy still gates actual use. */
  tools: Schema.Array(Schema.String),
  /**
   * A provider id ("anthropic") or a provider and model ("anthropic/claude-sonnet-5").
   * A bare provider takes its default model; absent means the first signed-in provider.
   */
  model: Schema.optional(Schema.String),
}) {}

export class AgentAlreadyRegistered extends Schema.TaggedError<AgentAlreadyRegistered>()(
  "AgentAlreadyRegistered",
  { name: Schema.String },
) {}

/** The agents as they stand while transforms replay. Edits apply in transform order. */
export interface AgentDraft {
  list(): ReadonlyArray<AgentDefinition>;
  get(name: string): Option.Option<AgentDefinition>;
  set(agent: AgentDefinition): void;
  update(name: string, f: (agent: AgentDefinition) => AgentDefinition): void;
  remove(name: string): void;
}

export interface AgentDomain {
  /**
   * Contribute or edit agents. Every transform replays, in plugin order, from
   * an empty draft whenever the domain rebuilds, so a transform must be pure
   * in its inputs or call `rebuild` when they change.
   */
  transform(
    apply: (draft: AgentDraft) => Effect.Effect<void>,
  ): Effect.Effect<Registration, never, Scope.Scope>;
  /** Replay every transform now and publish the result. */
  readonly rebuild: Effect.Effect<void>;
}
