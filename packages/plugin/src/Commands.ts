import type { Conversation, TokenUsage } from "@magentic/protocol";
import type { Effect, Option, Scope } from "effect";
import { Schema } from "effect";
import type { PluginSetupError, Registration } from "./Plugin.ts";

/** One row in a picker. `detail` sits at the right edge; a `marked` row carries a star. */
export interface PickItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly marked?: boolean | undefined;
}

export interface PickSection {
  readonly title: string;
  readonly items: ReadonlyArray<PickItem>;
}

/** A key that acts on the row under the cursor without choosing it, e.g. `f` to favourite. */
export interface PickAction {
  readonly key: string;
  readonly label: string;
}

/**
 * A list to choose from, described rather than drawn, so any surface can show
 * it. Commands loop on `pick`: show, act on the answer, show again.
 */
export interface Picker {
  readonly title: string;
  readonly sections: ReadonlyArray<PickSection>;
  readonly actions?: ReadonlyArray<PickAction>;
  /** The item the cursor starts on; the first item otherwise. */
  readonly cursor?: string | undefined;
}

/** The row the person landed on, and the action key when one was pressed instead of enter. */
export interface Picked {
  readonly id: string;
  readonly action: Option.Option<string>;
}

/** How a command talks to the person. Surfaces implement it; commands only describe. */
export interface CommandUi {
  /** Show a picker until the person chooses a row or backs out (none). */
  pick(picker: Picker): Effect.Effect<Option.Option<Picked>>;
  /** A line in the transcript. */
  notify(message: string): Effect.Effect<void>;
}

/** Tokens this chat has used: the latest model call, whose input is the context in use, and running totals. */
export interface SessionUsage {
  readonly latest: TokenUsage;
  /** Model calls since the chat opened; a run with tool calls makes several. */
  readonly calls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

/** A command that could not do what was asked, in words for the transcript. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** The chat a command runs in, and what it may change about it. */
export interface ChatSession {
  readonly agent: string;
  /** The `provider/model` runs use, when one was chosen. */
  readonly model: Effect.Effect<Option.Option<string>>;
  setModel(ref: string): Effect.Effect<void>;
  /** None before the first reply. */
  readonly usage: Effect.Effect<Option.Option<SessionUsage>>;
  /** The conversation the next input continues; none until the first run, or after `startNew`. */
  readonly conversation: Effect.Effect<Option.Option<Conversation>>;
  /** This agent's earlier conversations on the gateway, newest first. */
  readonly conversations: Effect.Effect<ReadonlyArray<Conversation>, CommandError>;
  /** Show an earlier conversation and continue it from here. */
  resume(id: string): Effect.Effect<void, CommandError>;
  /** Clear the transcript; the next input starts a conversation. */
  readonly startNew: Effect.Effect<void>;
  /** Fold the conversation so far into a summary the model continues from. */
  readonly compact: Effect.Effect<void, CommandError>;
}

export interface CommandInput {
  readonly ui: CommandUi;
  readonly session: ChatSession;
  /** Whatever followed the name, trimmed; empty when nothing did. */
  readonly args: string;
}

/** A slash command in a chat: `/name args`. */
export interface CommandRegistration {
  /** Without the slash, unique across plugins. */
  readonly name: string;
  readonly description: string;
  run(input: CommandInput): Effect.Effect<void, CommandError>;
}

export interface CommandDomain {
  register(
    command: CommandRegistration,
  ): Effect.Effect<Registration, PluginSetupError, Scope.Scope>;
}
