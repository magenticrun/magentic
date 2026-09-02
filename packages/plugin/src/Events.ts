import type { RunEvent } from "@magentic/protocol";
import type { Stream } from "effect";

/** Everything a run emits, tagged with the run it belongs to. */
export interface RunEventEnvelope {
  readonly runId: string;
  readonly agent: string;
  readonly event: RunEvent;
}

export interface EventDomain {
  /** Observe runs as they happen. Never blocks a run; slow observers drop events. */
  subscribe<Tag extends RunEvent["_tag"]>(
    tag: Tag,
  ): Stream.Stream<RunEventEnvelope & { readonly event: Extract<RunEvent, { _tag: Tag }> }>;
}
