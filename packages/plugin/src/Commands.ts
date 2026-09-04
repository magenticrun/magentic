import type {
  Conversation,
  McpServerInfo,
  ReadScheduleResult,
  ScheduledTask,
  TokenUsage,
} from "@magentic/protocol";
import type { DateTime, Effect, Option, Scope } from "effect";
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

/**
 * A key that acts on the row under the cursor without choosing it, e.g. `f`
 * to favourite. A letter on its own types into the filter, so surfaces bind
 * the key with ctrl (`ctrl+f`).
 */
export interface PickAction {
  readonly key: string;
  readonly label: string;
}

/**
 * A list to choose from, described rather than drawn, so any surface can show
 * it. Commands loop on `pick`: show, act on the answer, show again. Typing
 * filters the rows by label and detail.
 */
export interface Picker {
  readonly title: string;
  readonly sections: ReadonlyArray<PickSection>;
  /**
   * Rows a filter finds that the list does not show: the level below,
   * flattened, so typing at the top reaches it. A row in a section too is
   * shown once, in its unlisted place.
   */
  readonly unlisted?: ReadonlyArray<PickItem>;
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
  /** Dollars spent since the chat opened, at the catalog's prices; absent when no call had a price. */
  readonly totalCost?: number | undefined;
}

/** A command that could not do what was asked, in words for the transcript. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** What a command asks for when it sets up a repeat. */
export interface CreateSessionSchedule {
  readonly prompt: string;
  readonly intervalMillis: number;
  /** When it stops on its own; the gateway's own ceiling applies otherwise. */
  readonly until?: DateTime.Utc | undefined;
}

/**
 * The repeats set up on this chat.
 *
 * Deliberately narrow. A command says what should repeat and how often; the
 * gateway owns the timers, the principal, and the admission of every turn they
 * start. Handing a command anything that could start a run itself would be the
 * one way around identity, policy, and audit, which is the thing the plugin
 * boundary exists to prevent.
 */
export interface SessionSchedules {
  readonly list: Effect.Effect<ReadonlyArray<ScheduledTask>, CommandError>;
  /**
   * Read a cadence the surface's own parser would not have, by asking a
   * model what the words meant. Nothing is scheduled by this; the command
   * shows what came back and creates the loop only if it goes on to.
   */
  read(text: string): Effect.Effect<ReadScheduleResult, CommandError>;
  create(input: CreateSessionSchedule): Effect.Effect<ScheduledTask, CommandError>;
  /** False when nothing on this chat has that id. */
  remove(id: string): Effect.Effect<boolean, CommandError>;
  /** Stop every repeat on this chat; how many there were. */
  readonly removeAll: Effect.Effect<number, CommandError>;
}

/** The chat a command runs in, and what it may change about it. */
export interface ChatSession {
  readonly agent: string;
  /** The `provider/model` runs use, when one was chosen. */
  readonly model: Effect.Effect<Option.Option<string>>;
  setModel(ref: string): Effect.Effect<void>;
  /** How hard the model is asked to think, one of its `reasoningLevels`; none for its default. */
  readonly reasoning: Effect.Effect<Option.Option<string>>;
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
  /** Give the current conversation a title of the person's choosing. */
  rename(title: string): Effect.Effect<void, CommandError>;
  /** The MCP servers the gateway was configured with, connected or not, by name. */
  readonly mcpServers: Effect.Effect<ReadonlyArray<McpServerInfo>, CommandError>;
  /** What repeats on this chat, and how to start and stop one. */
  readonly schedules: SessionSchedules;
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
