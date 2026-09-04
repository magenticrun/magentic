import {
  decodePasteBytes,
  type ScrollAcceleration,
  type ScrollBoxRenderable,
  type TextareaOptions,
  type TextareaRenderable,
  type ThemeMode,
} from "@opentui/core";
import { parseModelRef, type Picked, type Picker } from "@magentic/plugin";
import type { Attachment, RunEvent, TranscriptEntry } from "@magentic/protocol";
import { type JSX, useKeyboard, usePaste, useRenderer } from "@opentui/solid";
import { DateTime, Option, Predicate, type Schema } from "effect";
import type { Message } from "../Attachments.ts";
import type { HistoryEntry } from "../History.ts";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Logo } from "./Logo.tsx";
import { markdownStyleFor, subtleStyleFor } from "./Markdown.ts";
import {
  attached,
  composerStyleFor,
  FOLD_STYLE,
  type Folded,
  imageAtPath,
  imagePlaceholder,
  normalise,
  readClipboard,
  shouldFold,
  textPlaceholder,
  toAttachment,
  unfold,
  writeClipboard,
} from "./Paste.ts";
import { PickerView } from "./Picker.tsx";
import { type Palette, paletteFor } from "./Theme.ts";

type TextLine = {
  /** A note is what a command reports, in the transcript but not from the agent. */
  readonly kind: "user" | "assistant" | "error" | "note";
  readonly text: string;
  readonly model?: string;
  readonly tokensPerSecond?: number;
};

/** A compaction summary, folded behind its transcript marker until opened. */
type SummaryLine = {
  readonly kind: "summary";
  readonly text: string;
  readonly messagesBefore?: number;
  readonly expanded: boolean;
};

type ToolResult = { readonly ok: boolean; readonly text: string; readonly raw: Schema.Json };

type ToolLine = {
  readonly kind: "tool";
  /** The call's id, which its result carries too. */
  readonly id: string;
  readonly name: string;
  readonly params: string;
  /** The arguments as the model gave them, for the detail under the call. */
  readonly raw: Schema.Json;
  /** Absent while the tool is still running. */
  readonly result?: ToolResult;
};

/**
 * What the model thought before it answered, shown as it streams and folded
 * to one line once it has, the way opencode does. Measured in ticks of the
 * run's clock, since that is what the footer counts too.
 */
type ThinkingLine = {
  readonly kind: "thinking";
  readonly text: string;
  readonly startedTick: number;
  /** Absent while the model is still thinking. */
  readonly endedTick?: number;
  /** Whether the person opened the folded text again. */
  readonly expanded: boolean;
};

type Line = TextLine | SummaryLine | ToolLine | ThinkingLine;

/**
 * Something that keeps starting runs on this conversation: a `/loop` today,
 * and whatever else comes later. Described rather than named, so the footer
 * and the escape key learn nothing about what kind it is.
 */
interface Driver {
  readonly id: string;
  readonly kind: string;
  /** `Loop 10 minutes`. */
  readonly label: string;
  /** What it repeats, or why it ended. */
  readonly detail: string;
  /** When it next runs; none when it can no longer run. */
  readonly nextAt: Option.Option<DateTime.Utc>;
}

/** Mutable on purpose: Solid's store setters address fields by name. */
type State = {
  /** The `provider/model` runs use, when known. */
  model: Option.Option<string>;
  /** Ticks of the spinner since the run began; 0 between runs. */
  ticks: number;
  /** Tokens the latest model call held, input and output; 0 before the first reply. */
  contextTokens: number;
  /** How many tokens the model can hold; 0 when the catalog does not say. */
  contextWindow: number;
  /** How hard the model is asked to think, one of its levels; none for its default. */
  reasoning: Option.Option<string>;
  /** Dollars this chat has spent at the catalog's prices; none until a priced call. */
  cost: Option.Option<number>;
  /** What the agent is doing right now; only shown while busy. */
  status: string;
  /** Background tasks of this conversation still running, as the gateway last said. */
  tasks: number;
  /**
   * What repeats on this conversation, as the gateway last said.
   *
   * Kept apart from `busy`, which means a run is in flight and drives the
   * spinner, the interrupt, and whether typing is queued or sent. A loop is
   * armed for hours; treating that as busy would hold every line the person
   * typed for as long as it ran.
   */
  driver: Option.Option<Driver>;
  /** Seconds left until the driver's next run, counted down here from `nextAt`. */
  countdown: number;
  lines: Array<Line>;
  busy: boolean;
  /** Whether tool results show in full under each call, as ctrl+o toggles. */
  expanded: boolean;
};

/** The frames Claude Code's spinner walks through, out and back. */
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✶", "✳", "✢"];
const TICK_MS = 100;
/** How long a first ctrl+c waits for the second before it is forgotten. */
const CONFIRM_MS = 2000;
/**
 * How long after one escape another means something different. Two presses in
 * quick succession are one intent — stop the run — and the second must not
 * fall through to stopping the loop the person meant to keep.
 */
const ESCAPE_APART_MS = 600;
/** How long the footer notes a copy. */
const FLASH_MS = 2000;
/** Rows per wheel notch, constant, as opencode scrolls unless told otherwise. */
const SCROLL_SPEED: ScrollAcceleration = { tick: () => 3, reset: () => {} };
/** The composer grows with its text up to this many rows, then scrolls inside. */
const MAX_INPUT_ROWS = 8;
/**
 * OpenTUI's textarea breaks the line on enter and sends on meta+enter; a chat
 * composer wants the opposite, so enter sends and shift+enter breaks the line.
 */
const COMPOSER_KEYS: NonNullable<TextareaOptions["keyBindings"]> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
];

/** `842`, `3.2k`, `12k`, `1M`: two or three figures, whatever the size. */
const formatTokens = (count: number): string => {
  // What would round up to 1000k is 1M.
  if (count >= 1_000_000 || Math.round(count / 1000) >= 1000) {
    return `${Number((count / 1_000_000).toFixed(1))}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1000)}k`;
  }
  return count >= 1000 ? `${Number((count / 1000).toFixed(1))}k` : `${count}`;
};

const isEnter = (name: string) => name === "return" || name === "kpenter" || name === "linefeed";

/** `$0.0123` under a cent, `$1.23` otherwise. */
const formatCost = (dollars: number): string =>
  dollars > 0 && dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;

const formatTokensPerSecond = (rate: number): string =>
  rate < 10 ? rate.toFixed(1) : `${Math.round(rate)}`;

/** `45s`, `1m 2s`, `2h 3m`: a duration in seconds, rounded down. */
const formatDuration = (seconds: number): string => {
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

/** Lines the detail under a tool call shows at most, folded or open. */
const DETAIL_FOLDED_LINES = 12;
const DETAIL_OPEN_LINES = 80;

/** One line of the detail under a tool call: a diff line, or a line of what came back. */
interface DetailLine {
  readonly sign: "-" | "+" | " ";
  readonly text: string;
  /** The part of the line that changed, when the diff is one line to one line. */
  readonly mark?: readonly [number, number];
}

/** The lines of a string, a trailing line break ending the last rather than starting an empty one. */
const linesOf = (text: string): ReadonlyArray<string> =>
  text.length === 0 ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

/** Where two one-line strings differ: the span between their common prefix and suffix. */
const changedSpan = (a: string, b: string): readonly [number, number] => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  return [start, a.length - end];
};

/** Removed lines then added lines, the way pi draws an edit; one line for one line marks what changed. */
const diffLines = (before: string, after: string): ReadonlyArray<DetailLine> => {
  const removed = linesOf(before);
  const added = linesOf(after);
  if (removed.length === 1 && added.length === 1) {
    const old = removed[0] ?? "";
    const now = added[0] ?? "";
    return [
      { sign: "-", text: old, mark: changedSpan(old, now) },
      { sign: "+", text: now, mark: changedSpan(now, old) },
    ];
  }
  return [
    ...removed.map((text): DetailLine => ({ sign: "-", text })),
    ...added.map((text): DetailLine => ({ sign: "+", text })),
  ];
};

const stringField = (value: Schema.Json, key: string): string | undefined => {
  if (!Predicate.isObject(value) || Array.isArray(value)) {
    return undefined;
  }
  const field = value[key];
  return Predicate.isString(field) ? field : undefined;
};

/** A tool result as lines: a command's output, a file's content, or the JSON otherwise. */
const resultLines = (name: string, result: ToolResult): ReadonlyArray<DetailLine> => {
  const plain = (text: string) =>
    linesOf(text).map((line): DetailLine => ({ sign: " ", text: line }));
  if (name === "shell") {
    const stdout = stringField(result.raw, "stdout") ?? "";
    const stderr = stringField(result.raw, "stderr") ?? "";
    return [...plain(stdout), ...plain(stderr)];
  }
  const content = stringField(result.raw, "content");
  if (name === "read_file" && content !== undefined) {
    return plain(content);
  }
  return plain(Predicate.isString(result.raw) ? result.raw : JSON.stringify(result.raw, null, 2));
};

/**
 * What shows under a tool call: an edit's diff and a written file's lines
 * always, and with ctrl+o what every tool got back. Long details are cut
 * with a count of what was left out.
 */
const detailOf = (tool: ToolLine, expanded: boolean): ReadonlyArray<DetailLine> => {
  const limit = expanded ? DETAIL_OPEN_LINES : DETAIL_FOLDED_LINES;
  const all = (() => {
    if (tool.name === "edit_file") {
      return diffLines(
        stringField(tool.raw, "oldString") ?? "",
        stringField(tool.raw, "newString") ?? "",
      );
    }
    if (tool.name === "write_file") {
      return linesOf(stringField(tool.raw, "content") ?? "").map((text): DetailLine => ({
        sign: "+",
        text,
      }));
    }
    return expanded && tool.result !== undefined ? resultLines(tool.name, tool.result) : [];
  })();
  if (all.length <= limit) {
    return all;
  }
  return [...all.slice(0, limit), { sign: " ", text: `… ${all.length - limit} more lines` }];
};

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
};

/** One line for a tool value: strings bare, everything else as JSON. */
const summarise = (value: Schema.Json): string =>
  clip(Predicate.isString(value) ? value : JSON.stringify(value));

/** Tool arguments the way Claude Code prints them: `path: CHANGELOG.md, limit: 20`. */
const summariseParams = (value: Schema.Json): string => {
  if (!Predicate.isObject(value)) {
    return summarise(value);
  }
  return clip(
    Object.entries(value)
      .map(([key, item]) => `${key}: ${Predicate.isString(item) ? item : JSON.stringify(item)}`)
      .join(", "),
  );
};

const asTool = (line: Line): ToolLine | undefined => (line.kind === "tool" ? line : undefined);
const asThinking = (line: Line): ThinkingLine | undefined =>
  line.kind === "thinking" ? line : undefined;
const asSummary = (line: Line | undefined): SummaryLine | undefined =>
  line?.kind === "summary" ? line : undefined;
const asText = (line: Line): TextLine | undefined =>
  line.kind === "tool" || line.kind === "thinking" || line.kind === "summary" ? undefined : line;
const responseInfo = (
  line: TextLine,
): { readonly model: string; readonly tokensPerSecond: number } | undefined =>
  line.kind === "assistant" && line.model !== undefined && line.tokensPerSecond !== undefined
    ? { model: line.model, tokensPerSecond: line.tokensPerSecond }
    : undefined;

/** `Thought for 12s`, `Thought for 1m 2s`; a thought shorter than a second still took one. */
const thoughtFor = (line: ThinkingLine): string => {
  const ticks = (line.endedTick ?? line.startedTick) - line.startedTick;
  return `Thought for ${formatDuration(Math.max(1, Math.round((ticks * TICK_MS) / 1000)))}`;
};

const summaryFor = (line: SummaryLine): string =>
  line.messagesBefore === undefined
    ? "Compacted conversation into a summary"
    : `Compacted ${line.messagesBefore} messages into a summary`;

/** What the slash-command popover lists. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
}

interface FileMention {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

type ComposerSuggestion =
  | { readonly kind: "command"; readonly command: CommandInfo }
  | { readonly kind: "file"; readonly path: string };

interface ComposerPopover {
  readonly kind: "command" | "file";
  readonly key: string;
  readonly items: ReadonlyArray<ComposerSuggestion>;
  readonly loading: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const displayWidth = (text: string): number => {
  let width = 0;
  for (const part of graphemes.segment(text)) {
    width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment);
  }
  return width;
};

const indexAtOffset = (text: string, offset: number): number => {
  if (offset <= 0) {
    return 0;
  }
  let width = 0;
  for (const part of graphemes.segment(text)) {
    const next = width + displayWidth(part.segment);
    if (next > offset) {
      return part.index;
    }
    width = next;
  }
  return text.length;
};

const mentionAt = (text: string, offset: number): FileMention | undefined => {
  const beforeCursor = text.slice(0, indexAtOffset(text, offset));
  const at = beforeCursor.lastIndexOf("@");
  if (at < 0) {
    return undefined;
  }
  const before = at === 0 ? undefined : beforeCursor[at - 1];
  const query = beforeCursor.slice(at + 1);
  if ((before !== undefined && !/\s/.test(before)) || /[\s@]/.test(query)) {
    return undefined;
  }
  return { start: displayWidth(beforeCursor.slice(0, at)), end: offset, query };
};

interface IndexedFile {
  readonly path: string;
  readonly lower: string;
  readonly name: string;
  readonly nameStart: number;
  readonly depth: number;
}

interface RankedFile {
  readonly file: IndexedFile;
  readonly score: number;
}

const indexFiles = (paths: ReadonlyArray<string>): ReadonlyArray<IndexedFile> =>
  paths.map((path) => {
    const lower = path.toLowerCase();
    const nameStart = path.lastIndexOf("/") + 1;
    return {
      path,
      lower,
      name: lower.slice(nameStart),
      nameStart,
      depth: path.split("/").length,
    };
  });

const isFileWordStart = (path: string, index: number): boolean =>
  index === 0 ||
  "/._- ".includes(path[index - 1] ?? "") ||
  (/[a-z]/.test(path[index - 1] ?? "") && /[A-Z]/.test(path[index] ?? ""));

const fuzzyFileScore = (
  file: IndexedFile,
  query: string,
  searchStart: number,
): number | undefined => {
  let best: number | undefined;
  let first = file.lower.indexOf(query[0] ?? "", searchStart);
  while (first >= 0) {
    let previous = first;
    let score = isFileWordStart(file.path, first) ? 24 : 0;
    let matched = true;
    for (let queryAt = 1; queryAt < query.length; queryAt++) {
      const at = file.lower.indexOf(query[queryAt] ?? "", previous + 1);
      if (at < 0) {
        matched = false;
        break;
      }
      const gap = at - previous - 1;
      score += gap === 0 ? 18 : isFileWordStart(file.path, at) ? 12 : -Math.min(gap, 12);
      previous = at;
    }
    if (matched) {
      const span = previous - first + 1;
      score += query.length * 10 + Math.max(0, 30 - (span - query.length));
      best = Math.max(best ?? -Infinity, score);
    }
    first = file.lower.indexOf(query[0] ?? "", first + 1);
  }
  return best;
};

const scoreFile = (file: IndexedFile, query: string): number | undefined => {
  if (file.lower === query) {
    return 20_000;
  }
  if (file.name === query) {
    return 19_000;
  }
  if (file.name.startsWith(query)) {
    return 18_000;
  }
  if (file.lower.startsWith(query)) {
    return 17_000;
  }
  const nameContains = file.name.indexOf(query);
  if (nameContains >= 0) {
    return 16_000 - nameContains;
  }
  const pathContains = file.lower.indexOf(query);
  if (pathContains >= 0) {
    return 15_000 + (isFileWordStart(file.path, pathContains) ? 100 : 0) - pathContains;
  }
  const nameScore = fuzzyFileScore(file, query, file.nameStart);
  if (nameScore !== undefined) {
    return 12_000 + nameScore;
  }
  const pathScore = fuzzyFileScore(file, query, 0);
  return pathScore === undefined ? undefined : 10_000 + pathScore;
};

const compareRankedFiles = (a: RankedFile, b: RankedFile): number => {
  const byScore = b.score - a.score;
  if (byScore !== 0) {
    return byScore;
  }
  const byDepth = a.file.depth - b.file.depth;
  return byDepth !== 0 ? byDepth : a.file.path.localeCompare(b.file.path);
};

const matchingFiles = (
  files: ReadonlyArray<IndexedFile>,
  rawQuery: string,
): ReadonlyArray<ComposerSuggestion> => {
  const query = rawQuery.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (query.length === 0) {
    return files.slice(0, 10).map(({ path }) => ({ kind: "file", path }));
  }

  const best: Array<RankedFile> = [];
  for (const file of files) {
    const score = scoreFile(file, query);
    if (score === undefined) {
      continue;
    }
    const ranked = { file, score };
    let at = 0;
    for (const current of best) {
      if (compareRankedFiles(current, ranked) > 0) {
        break;
      }
      at++;
    }
    if (at < 10) {
      best.splice(at, 0, ranked);
      if (best.length > 10) {
        best.pop();
      }
    }
  }
  return best.map(({ file }) => ({ kind: "file", path: file.path }));
};

/**
 * A message sent while a run was in flight. Steered into the run, it waits
 * for the model's next call and leaves the queue when the run says it got
 * there; held, it waits for the run to end, as a command does and as anything
 * does that the run would not take. The composer's draft as typed,
 * placeholders and all, so pulling it back into the composer restores it
 * exactly; and unfolded, as the run sees it, to match what it delivers.
 */
interface Queued {
  readonly draft: string;
  readonly folds: ReadonlyArray<Folded>;
  readonly text: string;
  /**
   * Sending: offered to the run, no answer yet. Steering: the run has it,
   * until it says it took it. Held: the run would not take it; goes out
   * when the run ends.
   */
  readonly status: "sending" | "steering" | "held";
}

/** A picker waiting for its answer. */
interface Dialog {
  readonly picker: Picker;
  readonly done: (picked: Option.Option<Picked>) => void;
}

export interface ChatTui {
  readonly view: () => JSX.Element;
  /** Fold one run event into the transcript. */
  apply(event: RunEvent): void;
  addUser(text: string): void;
  /** A line from a command. */
  note(text: string): void;
  error(text: string): void;
  /** The model later runs use, and how many tokens it can hold (0 when unknown). */
  setModel(ref: string, contextWindow: number): void;
  /** How hard the model is asked to think; none for its default. */
  setReasoning(level: Option.Option<string>): void;
  /** A word in the footer for a moment. */
  flash(text: string): void;
  /** Show a picker over the composer; `done` gets the answer. A second `pick` replaces it. */
  pick(picker: Picker, done: (picked: Option.Option<Picked>) => void): void;
  /** Close the picker, if one is open: the command that asked has ended. */
  dismiss(): void;
  /** Replace the transcript with an earlier conversation's, the context it last held, and what it cost. */
  restore(
    entries: ReadonlyArray<TranscriptEntry>,
    contextTokens: number,
    cost: Option.Option<number>,
  ): void;
  /** Clear the transcript for a new conversation. */
  reset(): void;
  /** Note that the person stopped the run in flight. */
  interrupted(): void;
  setStatus(status: string): void;
  /** Whether a run is in flight. Messages sent while it is are steered into it, or wait for it to end. */
  setBusy(busy: boolean): void;
  /** How many background tasks of the conversation are still running. */
  setTasks(running: number): void;
  /** What repeats on this conversation; none clears the footer. */
  setDriver(driver: Option.Option<Driver>): void;
}

export const createChatTui = (options: {
  /** Where the chat runs, as the header shows it. */
  readonly directory: string;
  readonly version: string;
  /** The `provider/model` the agent runs on, when the gateway could tell. */
  readonly model: Option.Option<string>;
  /** How many tokens the model can hold; 0 when unknown. */
  readonly contextWindow: number;
  /** Slash commands the composer completes. */
  readonly commands: ReadonlyArray<CommandInfo>;
  /** What was sent here before, oldest first, for the up arrow to walk back through. */
  readonly history: ReadonlyArray<HistoryEntry>;
  /** Keep a message the person sent, so a later session's arrows find it too. */
  readonly onRemember: (entry: HistoryEntry) => void;
  readonly listFiles: () => Promise<ReadonlyArray<string>>;
  readonly onPickFile: (path: string) => Promise<Option.Option<Message>>;
  /** The message with pasted text unfolded, and the images pasted into it. */
  readonly onSubmit: (text: string, attachments: ReadonlyArray<Attachment>) => void;
  /**
   * The same, sent while a run is in flight, for the run to read before its
   * next model call. False when the run would not take it (it ended first),
   * in which case it waits for the run to end and goes out then.
   */
  readonly onSteer: (text: string, attachments: ReadonlyArray<Attachment>) => Promise<boolean>;
  /** Take back what was steered but has not reached the model: those messages, oldest first. */
  readonly onRetract: () => Promise<ReadonlyArray<string>>;
  /** ctrl+t: the next thinking level. */
  readonly onCycleReasoning: () => void;
  /** Esc, or ctrl+c, while a run is in flight. Anything queued is back in the composer. */
  readonly onInterrupt: () => void;
  /** Esc with nothing running: stop what keeps starting runs on this conversation. */
  readonly onStopDriver: (id: string) => void;
  readonly onExit: () => void;
}): ChatTui => {
  const [state, setState] = createStore<State>({
    model: options.model,
    ticks: 0,
    contextTokens: 0,
    contextWindow: options.contextWindow,
    reasoning: Option.none(),
    cost: Option.none(),
    status: "",
    tasks: 0,
    driver: Option.none(),
    countdown: 0,
    lines: [],
    busy: false,
    expanded: false,
  });

  // Lines change in place. A line replaced by a copy is a new one to the
  // transcript's <For>, which drops its renderable and builds another; for
  // the reply being streamed that would re-parse the whole text every token.
  // Setting a field leaves the line as it is and redraws only what read it.
  const push = (line: Line) => setState("lines", state.lines.length, line);

  let pendingAssistant: number | undefined;
  let outputStartedTick: number | undefined;
  let outputEndedTick: number | undefined;
  const markOutput = () => {
    outputStartedTick ??= state.ticks;
    outputEndedTick = state.ticks;
  };

  const appendAssistant = (text: string) => {
    const last = state.lines.at(-1);
    if (last !== undefined && last.kind === "assistant") {
      setState("lines", state.lines.length - 1, { text: last.text + text });
    } else {
      pendingAssistant = state.lines.length;
      push({ kind: "assistant", text });
    }
  };

  const finishAssistant = (model: string | undefined, outputTokens: number) => {
    const index = pendingAssistant;
    // Only the line this run was streaming: a run that failed mid-reply
    // leaves the index behind, and /new or /resume can empty the transcript
    // under it, so the speed would land on another run's line or on nothing.
    const line = index === undefined ? undefined : state.lines[index];
    if (
      index !== undefined &&
      line?.kind === "assistant" &&
      model !== undefined &&
      outputStartedTick !== undefined &&
      outputEndedTick !== undefined
    ) {
      const seconds = (Math.max(1, outputEndedTick - outputStartedTick) * TICK_MS) / 1000;
      setState("lines", index, { model, tokensPerSecond: outputTokens / seconds });
    }
    pendingAssistant = undefined;
    outputStartedTick = undefined;
    outputEndedTick = undefined;
  };

  /**
   * Attach a result to the call it answers, by id: calls made in parallel
   * answer in any order, so the newest unfinished one is not necessarily it.
   */
  const finishTool = (id: string, name: string, result: ToolResult) => {
    for (let i = state.lines.length - 1; i >= 0; i--) {
      const line = state.lines[i];
      if (line !== undefined && line.kind === "tool" && line.id === id) {
        setState("lines", i, { result });
        return;
      }
    }
    push({ kind: "tool", id, name, params: "", raw: null, result });
  };

  /** Grow the thought in progress, or begin one. */
  const appendThinking = (text: string) => {
    const last = state.lines.at(-1);
    if (last !== undefined && last.kind === "thinking" && last.endedTick === undefined) {
      setState("lines", state.lines.length - 1, { text: last.text + text });
    } else {
      push({ kind: "thinking", text, startedTick: state.ticks, expanded: false });
    }
  };

  /** The model moved on from thinking; fold the thought. */
  const finishThinking = () => {
    const last = state.lines.at(-1);
    if (last !== undefined && last.kind === "thinking" && last.endedTick === undefined) {
      setState("lines", state.lines.length - 1, { endedTick: state.ticks });
    }
  };

  const toggleThinking = (index: number) => {
    const line = state.lines[index];
    if (line !== undefined && line.kind === "thinking") {
      setState("lines", index, { expanded: !line.expanded });
    }
  };

  const toggleSummary = (index: number) => {
    const line = state.lines[index];
    if (line !== undefined && line.kind === "summary") {
      setState("lines", index, { expanded: !line.expanded });
    }
  };

  // Signals rather than store fields: a dialog carries a callback. A command
  // that asks again replaces the picker in place, and the dialog only closes
  // when the command ends, so nothing flashes between two questions.
  const [dialog, setDialog] = createSignal<Dialog | undefined>(undefined);
  const pick = (picker: Picker, done: Dialog["done"]) => {
    let answered = false;
    setDialog({
      picker,
      done: (picked) => {
        if (answered) {
          return;
        }
        answered = true;
        done(picked);
      },
    });
  };
  const dismiss = () => setDialog(undefined);

  // Set by the view, which owns the composer and the queue: what was queued
  // during a run is sent the moment the run ends, and what the run took from
  // the queue leaves it.
  let flushQueue = () => {};
  let steered = (_inputs: ReadonlyArray<string>) => {};
  let showFlash = (_text: string) => {};

  const apply = (event: RunEvent) =>
    batch(() => {
      // Anything but more reasoning means the model has finished thinking.
      if (event._tag !== "ReasoningDelta") {
        finishThinking();
      }
      switch (event._tag) {
        case "RunStarted":
          pendingAssistant = undefined;
          outputStartedTick = undefined;
          outputEndedTick = undefined;
          setState("status", "Thinking…");
          return;
        case "TextDelta":
          markOutput();
          appendAssistant(event.text);
          return;
        case "ReasoningDelta":
          markOutput();
          appendThinking(event.text);
          return;
        case "ToolCall":
          markOutput();
          setState("status", `Running ${event.name}…`);
          push({
            kind: "tool",
            id: event.id,
            name: event.name,
            params: summariseParams(event.params),
            raw: event.params,
          });
          return;
        case "ToolResult":
          setState("status", "Thinking…");
          finishTool(event.id, event.name, {
            ok: !event.isFailure,
            text: summarise(event.result),
            raw: event.result,
          });
          return;
        case "Steered":
          // The run has them now: out of the queue and into the transcript, as sent.
          steered(event.inputs);
          for (const input of event.inputs) {
            push({ kind: "user", text: input });
          }
          return;
        case "Notified":
          // What the harness told the model, a background task's end for one.
          for (const notice of event.notices) {
            push({ kind: "note", text: notice });
          }
          return;
        case "TokenUsage": {
          const model = event.model ?? Option.getOrUndefined(state.model);
          finishAssistant(model, event.outputTokens);
          if (event.model !== undefined) {
            setState("model", Option.some(event.model));
          }
          setState("contextTokens", event.inputTokens + event.outputTokens);
          if (event.cost !== undefined) {
            const spent = event.cost;
            setState("cost", (before) => Option.some(Option.getOrElse(before, () => 0) + spent));
          }
          return;
        }
        case "CompactionStarted":
          setState("status", "Compacting…");
          return;
        case "Compacted":
          // Earlier lines stay on screen; the model continues from the folded summary.
          push({
            kind: "summary",
            text: event.summary,
            messagesBefore: event.messagesBefore,
            expanded: false,
          });
          setState({ contextTokens: 0, status: state.busy ? "Thinking…" : "" });
          return;
        case "Retrying": {
          const seconds = Math.ceil(event.delayMs / 1000);
          setState("status", `Retrying in ${seconds}s (${event.attempt} of ${event.limit})…`);
          push({ kind: "note", text: `${event.message}; retrying in ${seconds}s` });
          return;
        }
        case "RunFinished":
          setState("status", "");
          if (event.reason === "interrupted") {
            // A run the gateway started and the person stopped; their own runs end without an event.
            finishThinking();
            push({ kind: "error", text: "Interrupted" });
          }
          if (event.reason === "step-limit") {
            push({
              kind: "note",
              text: "Stopped at the agent's step limit; send another message to continue",
            });
          }
          return;
        case "RunFailed":
          setState("status", "");
          push({ kind: "error", text: event.message });
          return;
      }
    });

  /** A transcript entry the way the run events would have drawn it. */
  const toLine = (entry: TranscriptEntry): Line => {
    switch (entry._tag) {
      case "User":
        return { kind: "user", text: entry.text };
      case "Assistant":
        return { kind: "assistant", text: entry.text };
      case "Summary":
        return { kind: "summary", text: entry.text, expanded: false };
      case "Notice":
        return { kind: "note", text: entry.text };
      case "Scheduled":
        return { kind: "note", text: entry.text };
      case "Tool": {
        const call: ToolLine = {
          kind: "tool",
          id: entry.id,
          name: entry.name,
          params: summariseParams(entry.params),
          raw: entry.params,
        };
        return entry.result === undefined
          ? call
          : {
              ...call,
              result: { ok: !entry.isFailure, text: summarise(entry.result), raw: entry.result },
            };
      }
    }
  };

  const view = () => {
    // When escape was last pressed, so a double tap is read as one intent.
    let lastEscape = 0;
    // A first ctrl+c arms quitting for a moment; only a second one quits.
    const [armed, setArmed] = createSignal(false);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(disarm));
    // A word in the footer for a moment, such as that a selection was copied.
    const [flash, setFlash] = createSignal<string | undefined>(undefined);
    let unflash: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(unflash));
    showFlash = (text: string) => {
      setFlash(text);
      clearTimeout(unflash);
      unflash = setTimeout(() => setFlash(undefined), FLASH_MS);
    };
    // The composer keeps the keyboard, so the transcript scrolls from here
    // with opencode's keys and distances; the wheel reaches the scrollbox on
    // its own. OpenTUI calls alt `meta`.
    let scroll: ScrollBoxRenderable | undefined;
    const scrollKey = (key: { name: string; ctrl: boolean; meta: boolean }): boolean => {
      if (scroll === undefined) {
        return false;
      }
      const box = scroll;
      const alt = key.ctrl && key.meta;
      if (key.name === "pageup" || (alt && key.name === "b")) {
        box.scrollBy(-box.height / 2);
      } else if (key.name === "pagedown" || (alt && key.name === "f")) {
        box.scrollBy(box.height / 2);
      } else if (alt && key.name === "u") {
        box.scrollBy(-box.height / 4);
      } else if (alt && key.name === "d") {
        box.scrollBy(box.height / 4);
      } else if (alt && key.name === "y") {
        box.scrollBy(-1);
      } else if (alt && key.name === "e") {
        box.scrollBy(1);
      } else if (key.ctrl && !key.meta && key.name === "g") {
        box.scrollTo(0);
      } else if (alt && key.name === "g") {
        box.scrollTo(box.scrollHeight);
      } else {
        return false;
      }
      return true;
    };
    useKeyboard((key) => {
      if (dialog() === undefined && scrollKey(key)) {
        key.preventDefault();
        return;
      }
      const listed = popover();
      if (listed !== undefined && !key.ctrl && !key.meta) {
        const count = listed.items.length;
        const chosen = listed.items[selected()];
        if (key.name === "escape") {
          setDismissed(listed.key);
        } else if (count === 0) {
          return;
        } else if (key.name === "up") {
          setSelected((n) => (n - 1 + count) % count);
        } else if (key.name === "down") {
          setSelected((n) => (n + 1) % count);
        } else if ((key.name === "tab" || isEnter(key.name)) && chosen?.kind === "file") {
          void completeFile(chosen.path, listed.key);
        } else if (key.name === "tab" && chosen?.kind === "command") {
          complete(chosen.command);
        } else if (isEnter(key.name) && chosen?.kind === "command") {
          send(`/${chosen.command.name}`, []);
          clear();
        } else {
          return;
        }
        // Handled here; the composer must not also insert or submit.
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        if (dialog() !== undefined) {
          return;
        }
        // Escape takes the innermost live thing. A run in flight is
        // interrupted and the loop stays armed; only with nothing running does
        // escape stop the loop itself.
        if (state.busy) {
          lastEscape = Date.now();
          interrupt();
          return;
        }
        const driver = Option.getOrUndefined(state.driver);
        // A double tap meant to kill a stuck run is one intent, not two: the
        // second press must not also stop the loop the person wanted kept.
        if (driver !== undefined && Date.now() - lastEscape > ESCAPE_APART_MS) {
          lastEscape = Date.now();
          options.onStopDriver(driver.id);
        }
        return;
      }
      // The up arrow on an empty composer takes the queue back for editing.
      if (
        key.name === "up" &&
        !key.ctrl &&
        !key.meta &&
        dialog() === undefined &&
        queue().length > 0 &&
        (composer?.plainText ?? "").length === 0
      ) {
        key.preventDefault();
        void unqueue();
        return;
      }
      // With the queue empty, the arrows walk what was sent here before: up
      // from the composer's first row, down from its last, so a draft of
      // several lines still moves the cursor between them.
      if (
        (key.name === "up" || key.name === "down") &&
        !key.ctrl &&
        !key.meta &&
        !key.shift &&
        dialog() === undefined &&
        atEdgeRow(key.name === "up" ? "first" : "last") &&
        browse(key.name === "up" ? 1 : -1)
      ) {
        key.preventDefault();
        return;
      }
      if (key.ctrl && key.name === "v" && dialog() === undefined) {
        // The terminal pastes text itself; ctrl+v is for what it cannot paste, an image.
        key.preventDefault();
        void pasteClipboard();
        return;
      }
      if (key.ctrl && key.name === "t" && dialog() === undefined) {
        key.preventDefault();
        options.onCycleReasoning();
        return;
      }
      if (key.ctrl && key.name === "o" && dialog() === undefined) {
        key.preventDefault();
        setState("expanded", (open) => !open);
        return;
      }
      if (key.ctrl && key.name === "c") {
        if (armed()) {
          options.onExit();
          return;
        }
        if (state.busy) {
          interrupt();
        }
        setArmed(true);
        clearTimeout(disarm);
        disarm = setTimeout(() => setArmed(false), CONFIRM_MS);
      }
    });
    // The terminal answers OpenTUI's theme query once at start-up and again
    // whenever the person switches themes; follow both.
    const renderer = useRenderer();
    const [mode, setMode] = createSignal(renderer.themeMode);
    const onMode = (next: ThemeMode) => setMode(next);
    renderer.on("theme_mode", onMode);
    onCleanup(() => renderer.off("theme_mode", onMode));
    const palette = () => paletteFor(mode());
    const markdownStyle = () => markdownStyleFor(palette());

    // Dragging selects text, as OpenTUI does with the mouse on; letting go
    // copies it and clears the selection, as opencode does. A click that ends
    // a drag is not a click on what it landed on.
    const selecting = () => (renderer.getSelection()?.getSelectedText() ?? "").length > 0;
    const copySelection = async () => {
      const text = renderer.getSelection()?.getSelectedText() ?? "";
      if (text.length === 0) {
        return;
      }
      renderer.clearSelection();
      const copied = (await writeClipboard(text)) || renderer.copyToClipboardOSC52(text);
      showFlash(copied ? "copied to clipboard" : "could not reach the clipboard");
    };

    // Ticks since work began; drives the spinner, the elapsed seconds, and
    // how long each thought took.
    const active = () => state.busy || state.status.length > 0;
    createEffect(() => {
      if (!active()) {
        return;
      }
      setState("ticks", 0);
      const timer = setInterval(() => setState("ticks", (n) => n + 1), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
    const frame = () => FRAMES[state.ticks % FRAMES.length];
    const elapsed = () => Math.floor((state.ticks * TICK_MS) / 1000);

    // A loop between runs is waiting, not working, so it counts down rather
    // than spinning: nothing is happening, and how long until it does is the
    // thing worth showing. One second's tick is enough for a countdown.
    createEffect(() => {
      const driver = Option.getOrUndefined(state.driver);
      const nextAt = driver === undefined ? undefined : Option.getOrUndefined(driver.nextAt);
      if (nextAt === undefined) {
        setState("countdown", 0);
        return;
      }
      const left = () =>
        Math.max(0, Math.round((DateTime.toEpochMillis(nextAt) - Date.now()) / 1000));
      setState("countdown", left());
      const timer = setInterval(() => setState("countdown", left()), 1000);
      onCleanup(() => clearInterval(timer));
    });

    /** `9m 12s`, `45s`: what is left before the next run. */
    const remaining = () => formatDuration(state.countdown);

    // The composer keeps its own text; the view reads it on send and sizes
    // the box to the text, counting wrapped rows.
    let composer: TextareaRenderable | undefined;
    const [rows, setRows] = createSignal(1);
    const fitRows = () => {
      if (composer === undefined) {
        return;
      }
      const editor = composer.editorView;
      const total = Math.max(1, editor.getTotalVirtualLineCount());
      const next = Math.min(MAX_INPUT_ROWS, total);
      setRows(next);
      // Deleting text leaves the editor scrolled where it was, with blank
      // rows at the bottom; pull the viewport back up to the last rows.
      const viewport = editor.getViewport();
      const top = Math.max(0, total - next);
      if (viewport.offsetY > top) {
        editor.setViewport(viewport.offsetX, top, viewport.width, viewport.height, false);
      }
    };
    // What the composer's placeholders stand for; cleared with the text.
    let folds: Array<Folded> = [];
    const clear = () => {
      composer?.extmarks.clear();
      composer?.setText("");
      folds = [];
      setRows(1);
      setDraft("");
      setCursor(0);
      stopBrowsing();
    };
    // Messages sent while a run is in flight wait here, listed over the
    // composer: steered ones until the run takes them, held ones until it
    // ends, when whatever is left goes out together.
    const [queue, setQueue] = createSignal<ReadonlyArray<Queued>>([]);
    /** Every fold in play, queued ones first: placeholders are numbered across all of them. */
    const allFolds = () => [...queue().flatMap((q) => q.folds), ...folds];
    /**
     * Placeholder numbers only go up while any fold is in play, so a number
     * is never given twice while the composer may still hold its first
     * bearer; they start over once nothing is folded anywhere.
     */
    let numbered = { text: 0, file: 0 };
    const nextNumber = (kind: Folded["kind"]) => {
      if (allFolds().length === 0) {
        numbered = { text: 0, file: 0 };
      }
      numbered = { ...numbered, [kind]: numbered[kind] + 1 };
      return numbered[kind];
    };
    /** Send now; or, during a run, steer it in, and hold it when the run would not take it. */
    const send = (draft: string, drafted: ReadonlyArray<Folded>) => {
      const text = unfold(draft, drafted);
      const files = attached(draft, drafted);
      remember(draft, drafted);
      if (!state.busy) {
        options.onSubmit(text, files);
        return;
      }
      if (draft.startsWith("/")) {
        setQueue((held) => [...held, { draft, folds: drafted, text, status: "held" }]);
        return;
      }
      const item: Queued = { draft, folds: drafted, text, status: "sending" };
      setQueue((held) => [...held, item]);
      void options.onSteer(text, files).then((accepted) => {
        setQueue((held) =>
          held.map((q) => (q === item ? { ...q, status: accepted ? "steering" : "held" } : q)),
        );
      });
    };
    steered = (inputs) => {
      for (const input of inputs) {
        setQueue((held) => {
          const at = held.findIndex((q) => q.status !== "held" && q.text === input);
          return at < 0 ? held : held.toSpliced(at, 1);
        });
      }
    };
    /**
     * What was queued, as one message; consecutive messages join with a line
     * break, the way Claude Code sends them, and a command goes on its own.
     */
    const flush = () => {
      const held = queue();
      if (held.length === 0) {
        return;
      }
      setQueue([]);
      let run: Array<Queued> = [];
      const sendBatch = () => {
        if (run.length === 0) {
          return;
        }
        const text = run.map((q) => q.draft).join("\n");
        const batched = run.flatMap((q) => q.folds);
        options.onSubmit(unfold(text, batched), attached(text, batched));
        run = [];
      };
      for (const item of held) {
        if (item.draft.startsWith("/")) {
          sendBatch();
          options.onSubmit(item.draft, []);
        } else {
          run.push(item);
        }
      }
      sendBatch();
    };
    flushQueue = flush;
    /**
     * The numbers placeholders coming back to the composer already carry, so
     * the next paste is numbered past them rather than over one of them.
     */
    const takeNumbers = (entries: ReadonlyArray<Folded>) => {
      for (const entry of entries) {
        const carried = /#(\d+)/.exec(entry.placeholder)?.[1];
        if (carried !== undefined) {
          numbered = { ...numbered, [entry.kind]: Math.max(numbered[entry.kind], Number(carried)) };
        }
      }
    };
    /** Put this text in the composer, its placeholders styled again, cursor at the end. */
    const setComposer = (text: string, entries: ReadonlyArray<Folded>) => {
      if (composer === undefined) {
        return;
      }
      takeNumbers(entries);
      composer.extmarks.clear();
      composer.setText(text);
      const styleId = composerStyleFor(palette()).getStyleId(FOLD_STYLE);
      for (const entry of entries) {
        const index = text.indexOf(entry.placeholder);
        if (index >= 0) {
          const start = displayWidth(text.slice(0, index));
          const range = { start, end: start + displayWidth(entry.placeholder), virtual: true };
          composer.extmarks.create(styleId === null ? range : { ...range, styleId });
        }
      }
      folds = [...entries];
      composer.cursorOffset = displayWidth(text);
      onDraft();
    };
    /** Some of the queue back in the composer, ahead of whatever is being typed, placeholders restored. */
    const restore = (held: ReadonlyArray<Queued>) => {
      if (composer === undefined || held.length === 0) {
        return;
      }
      setQueue([]);
      const current = composer.plainText;
      const drafts = held.map((q) => q.draft);
      const text = (current.length === 0 ? drafts : [...drafts, current]).join("\n");
      setComposer(text, [...held.flatMap((q) => q.folds), ...folds]);
      // What is in the composer is no longer what the arrows put there.
      stopBrowsing();
    };

    // What has been sent from this composer, oldest first: what this
    // directory held when the chat opened, and every message sent since.
    let history: ReadonlyArray<HistoryEntry> = options.history;
    // How far back the arrows have walked. Zero is the draft being typed,
    // one the message sent last; `setAside` is the draft the walk left
    // behind, to be given back at the near end of it.
    let steppedBack = 0;
    let setAside: HistoryEntry | undefined;
    const stopBrowsing = () => {
      steppedBack = 0;
      setAside = undefined;
    };
    /** Keep what was just sent, unless it says the same as the message before it. */
    const remember = (draft: string, drafted: ReadonlyArray<Folded>) => {
      if (draft.length === 0 || history.at(-1)?.draft === draft) {
        return;
      }
      // Only the placeholders still standing: what was pasted and then
      // deleted is no part of the message, and nothing should bring it back.
      const entry: HistoryEntry = {
        draft,
        folds: drafted.filter((fold) => draft.includes(fold.placeholder)),
      };
      history = [...history, entry];
      options.onRemember(entry);
    };
    /**
     * One step along the history, as Claude Code's arrows walk it: back
     * towards older messages, forward towards newer, and one step past the
     * newest is the draft that was being typed when the walk began. False
     * when there is nothing that way, so the key stays the composer's.
     */
    const browse = (steps: 1 | -1): boolean => {
      const next = steppedBack + steps;
      if (next < 0 || next > history.length) {
        return false;
      }
      const entry = next === 0 ? setAside : history[history.length - next];
      if (entry === undefined) {
        return false;
      }
      if (steppedBack === 0) {
        setAside = { draft: composer?.plainText ?? "", folds };
      }
      setComposer(entry.draft, entry.folds);
      steppedBack = next;
      if (next === 0) {
        setAside = undefined;
      }
      return true;
    };
    /**
     * Whether the cursor is on the composer's first or last row, counting the
     * rows a long line wraps onto: a draft of several lines moves the cursor
     * between them, and only the row past the end reaches the history.
     */
    const atEdgeRow = (edge: "first" | "last"): boolean => {
      if (composer === undefined) {
        return false;
      }
      const editor = composer.editorView;
      const row = editor.getViewport().offsetY + composer.visualCursor.visualRow;
      return edge === "first"
        ? row === 0
        : row >= Math.max(1, editor.getTotalVirtualLineCount()) - 1;
    };
    /**
     * The queue back in the composer: what is held, and what was steered
     * but the run has not taken yet. Asking the run what that is takes a
     * moment; what it took meanwhile has left the queue by the time it answers.
     */
    const unqueue = async () => {
      if (queue().length === 0) {
        return;
      }
      const pending = queue().some((q) => q.status !== "held") ? await options.onRetract() : [];
      // What the run has not answered for yet is not with it either.
      restore(queue().filter((q) => q.status !== "steering" || pending.includes(q.text)));
    };
    /** Stop the run; what was queued and not yet taken comes back to be edited or sent again. */
    const interrupt = () => {
      void unqueue().then(() => options.onInterrupt());
    };
    const submit = () => {
      if (composer === undefined) {
        return;
      }
      const draft = composer.plainText.trim();
      if (draft.length === 0 || dialog() !== undefined) {
        return;
      }
      send(draft, folds);
      clear();
    };

    /** Put a placeholder at the cursor, styled and moved over as one unit. */
    const fold = (entry: Folded, suffix = " ") => {
      if (composer === undefined) {
        return;
      }
      const start = composer.cursorOffset;
      composer.insertText(entry.placeholder + suffix);
      const range = { start, end: start + displayWidth(entry.placeholder), virtual: true };
      const styleId = composerStyleFor(palette()).getStyleId(FOLD_STYLE);
      composer.extmarks.create(styleId === null ? range : { ...range, styleId });
      folds = [...folds, entry];
    };
    /** Long pastes fold; a placeholder pasted back unfolds first so it never nests. */
    const pasteText = (raw: string) => {
      const text = unfold(normalise(raw), folds);
      if (!shouldFold(text)) {
        composer?.insertText(text);
        return;
      }
      fold({ kind: "text", placeholder: textPlaceholder(nextNumber("text"), text), text });
    };
    const attach = (attachment: Attachment) => {
      fold({ kind: "file", placeholder: imagePlaceholder(nextNumber("file")), attachment });
    };
    /** Pasted text is an image when it is the path of one; a dropped file pastes its path. */
    const pasteTextOrPath = async (text: string) => {
      const image = await imageAtPath(text);
      if (image === undefined) {
        pasteText(text);
      } else {
        attach(image);
      }
    };
    const pasteClipboard = async () => {
      const held = await readClipboard();
      if (held.kind === "image") {
        attach(toAttachment(held.mediaType, held.bytes));
      } else if (held.kind === "text") {
        await pasteTextOrPath(held.text);
      }
    };
    // Bracketed paste from the terminal. An empty one is how some terminals
    // paste an image, so the clipboard is read directly then.
    usePaste((event) => {
      if (dialog() !== undefined) {
        return;
      }
      event.preventDefault();
      const text = decodePasteBytes(event.bytes);
      void (text.trim().length === 0 ? pasteClipboard() : pasteTextOrPath(text));
    });

    // While the draft is one word starting with a slash, the commands it could
    // become are listed under the composer: tab completes, enter runs.
    const [draft, setDraft] = createSignal("");
    const [cursor, setCursor] = createSignal(0);
    const [dismissed, setDismissed] = createSignal<string | undefined>(undefined);
    const [selected, setSelected] = createSignal(0);
    const [files, setFiles] = createSignal<ReadonlyArray<IndexedFile> | undefined>(undefined);
    const [loadingFiles, setLoadingFiles] = createSignal(false);
    const commandSuggestions = createMemo(() => {
      const text = draft();
      if (!text.startsWith("/") || /\s/.test(text)) {
        return [];
      }
      const prefix = text.slice(1);
      return options.commands
        .filter((command) => command.name.startsWith(prefix))
        .map((command): ComposerSuggestion => ({ kind: "command", command }));
    });
    const fileMention = createMemo(() => mentionAt(draft(), cursor()));
    let mentionWasOpen = false;
    let fileScan = 0;
    createEffect(() => {
      const open = fileMention() !== undefined;
      if (open && !mentionWasOpen) {
        const scan = ++fileScan;
        setLoadingFiles(true);
        void options.listFiles().then(
          (paths) => {
            if (scan === fileScan) {
              setFiles(indexFiles(paths));
              setLoadingFiles(false);
            }
          },
          () => {
            if (scan === fileScan) {
              setFiles(files() ?? []);
              setLoadingFiles(false);
            }
          },
        );
      }
      mentionWasOpen = open;
    });
    const fileSuggestions = createMemo(() =>
      matchingFiles(files() ?? [], fileMention()?.query ?? ""),
    );
    const offered = createMemo<ComposerPopover | undefined>(() => {
      const mention = fileMention();
      if (mention !== undefined) {
        return {
          kind: "file",
          key: `file:${mention.start}:${mention.end}:${mention.query}`,
          items: fileSuggestions(),
          loading: loadingFiles(),
        };
      }
      const commands = commandSuggestions();
      return commands.length === 0
        ? undefined
        : { kind: "command", key: `command:${draft()}`, items: commands, loading: false };
    });
    const popover = () => {
      const next = dialog() === undefined ? offered() : undefined;
      return next?.key === dismissed() ? undefined : next;
    };
    let shownKey: string | undefined;
    createEffect(() => {
      const key = offered()?.key;
      if (key !== shownKey) {
        shownKey = key;
        setSelected(0);
      }
    });
    /** The footer shows the provider and model joined with a `/`; a bare provider means its default model. */
    const modelParts = () =>
      Option.map(state.model, (ref) => {
        const parsed = parseModelRef(ref);
        return {
          provider: parsed.provider,
          model: Option.getOrElse(parsed.model, () => "default"),
        };
      });
    /** `3% of 1M context`, or the bare count when the window is unknown; nothing before the first reply. */
    const contextInfo = () => {
      const used = state.contextTokens;
      if (used === 0) {
        return undefined;
      }
      if (state.contextWindow === 0) {
        return `${formatTokens(used)} tokens in context`;
      }
      const share = (used / state.contextWindow) * 100;
      return `${share < 1 ? "<1" : Math.round(share)}% of ${formatTokens(state.contextWindow)} context`;
    };
    const onDraft = () => {
      fitRows();
      setDraft(composer?.plainText ?? "");
      setCursor(composer?.cursorOffset ?? 0);
    };
    const complete = (command: CommandInfo) => {
      if (composer === undefined) {
        return;
      }
      const text = `/${command.name} `;
      composer.setText(text);
      composer.cursorOffset = displayWidth(text);
      setDraft(text);
      setCursor(composer.cursorOffset);
    };
    const completeFile = async (path: string, key: string) => {
      if (composer === undefined) {
        return;
      }
      const input = composer;
      const mention = fileMention();
      const snapshot = input.plainText;
      if (mention === undefined || offered()?.key !== key) {
        return;
      }
      setDismissed(key);
      const picked = await options.onPickFile(path);
      if (Option.isNone(picked)) {
        showFlash(`could not read ${path}`);
        return;
      }
      const current = mentionAt(input.plainText, input.cursorOffset);
      if (
        input.plainText !== snapshot ||
        current === undefined ||
        `file:${current.start}:${current.end}:${current.query}` !== key
      ) {
        return;
      }
      const after = snapshot.slice(indexAtOffset(snapshot, current.end));
      const suffix = after.length === 0 || !/^\s/.test(after) ? " " : "";
      input.cursorOffset = current.start;
      const start = input.logicalCursor;
      input.cursorOffset = current.end;
      const end = input.logicalCursor;
      input.deleteRange(start.row, start.col, end.row, end.col);
      input.cursorOffset = current.start;
      const marker = `@${path}`;
      const attachment = picked.value.attachments[0];
      const entry: Folded =
        attachment === undefined
          ? { kind: "text", placeholder: marker, text: picked.value.text }
          : { kind: "file", placeholder: marker, attachment };
      fold(entry, suffix);
      onDraft();
    };

    const bullet = (colours: Palette, line: ToolLine) =>
      line.result === undefined ? colours.muted : line.result.ok ? colours.success : colours.error;
    const detailColour = (colours: Palette, line: DetailLine) =>
      line.sign === "-" ? colours.error : line.sign === "+" ? colours.success : colours.muted;
    /** Whether any call has run, so the footer can offer ctrl+o. */
    const hasTools = () => state.lines.some((line) => line.kind === "tool");
    const hint = () => {
      if (queue().length > 0) {
        return "↑ to edit queued messages";
      }
      return hasTools()
        ? `ctrl+o ${state.expanded ? "fold" : "open"} tool output · shift+enter newline`
        : "shift+enter newline";
    };
    const lineColour = (colours: Palette, line: TextLine) =>
      line.kind === "error" ? colours.error : line.kind === "note" ? colours.muted : colours.text;

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        paddingLeft={1}
        paddingRight={1}
        onMouseUp={() => void copySelection()}
      >
        <scrollbox
          ref={(node: ScrollBoxRenderable) => {
            scroll = node;
          }}
          stickyScroll
          stickyStart="bottom"
          scrollAcceleration={SCROLL_SPEED}
          verticalScrollbarOptions={{ visible: false }}
          flexGrow={1}
          flexShrink={1}
          marginTop={1}
        >
          <box flexDirection="row" flexShrink={0} marginBottom={1}>
            <Logo palette={palette()} />
            {/* One row beside a three-row mark, level with the dot. */}
            <box
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              flexGrow={1}
              flexShrink={1}
              marginLeft={2}
            >
              <text fg={palette().text} wrapMode="none" flexShrink={0}>
                <strong>magentic</strong>
              </text>
              <text fg={palette().muted} wrapMode="none" truncate flexShrink={1} marginLeft={2}>
                {options.directory} · v{options.version}
              </text>
            </box>
          </box>
          <For each={state.lines}>
            {(line, index) => (
              <Switch>
                <Match when={asThinking(line)}>
                  {(thought) => (
                    <box flexDirection="column" marginBottom={1}>
                      {/*
                        A thought in progress carries no header: the footer is
                        already saying `Thinking…` on its own line, and there is
                        nothing to fold yet. The header arrives with the duration
                        it reports; click it to open the thought again, or fold it.
                      */}
                      <Show when={thought().endedTick !== undefined}>
                        <box
                          flexDirection="row"
                          onMouseUp={() => {
                            if (!selecting()) {
                              toggleThinking(index());
                            }
                          }}
                        >
                          <text fg={palette().muted} flexShrink={0}>
                            {"⏺"}
                          </text>
                          <text fg={palette().muted} marginLeft={1} wrapMode="none">
                            {thoughtFor(thought())}
                          </text>
                        </box>
                      </Show>
                      <Show when={thought().endedTick === undefined || thought().expanded}>
                        <box marginLeft={2}>
                          <markdown
                            content={thought().text}
                            syntaxStyle={subtleStyleFor(palette())}
                            fg={palette().muted}
                            streaming={thought().endedTick === undefined}
                            internalBlockMode="top-level"
                          />
                        </box>
                      </Show>
                    </box>
                  )}
                </Match>
                <Match when={asTool(line)}>
                  {(tool) => (
                    <box flexDirection="row" marginBottom={1}>
                      <text fg={bullet(palette(), tool())}>{"⏺ "}</text>
                      <box flexDirection="column" flexGrow={1} flexShrink={1}>
                        <text fg={palette().text}>
                          <strong>{tool().name}</strong>
                          <span style={{ fg: palette().muted }}>({tool().params})</span>
                        </text>
                        <Show when={tool().result}>
                          {(result) => (
                            <text fg={result().ok ? palette().muted : palette().error}>
                              {"⎿  "}
                              {result().text}
                            </text>
                          )}
                        </Show>
                        <For each={detailOf(tool(), state.expanded)}>
                          {(detail) => (
                            <text fg={detailColour(palette(), detail)} wrapMode="none" truncate>
                              {"   "}
                              {detail.sign === " " ? "" : `${detail.sign} `}
                              <Show when={detail.mark} fallback={detail.text}>
                                {(mark) => (
                                  <>
                                    {detail.text.slice(0, mark()[0])}
                                    <strong>{detail.text.slice(mark()[0], mark()[1])}</strong>
                                    {detail.text.slice(mark()[1])}
                                  </>
                                )}
                              </Show>
                            </text>
                          )}
                        </For>
                      </box>
                    </box>
                  )}
                </Match>
                <Match when={asSummary(line)}>
                  {(summary) => (
                    <box flexDirection="column" marginBottom={1}>
                      <box
                        flexDirection="row"
                        onMouseUp={() => {
                          if (!selecting()) {
                            toggleSummary(index());
                          }
                        }}
                      >
                        <text fg={palette().muted} flexShrink={0}>
                          {"◐"}
                        </text>
                        <text fg={palette().muted} marginLeft={1} wrapMode="none">
                          {summaryFor(summary())}
                        </text>
                      </box>
                      <Show when={asSummary(state.lines[index()])?.expanded}>
                        <box marginLeft={2}>
                          <markdown
                            content={summary().text}
                            syntaxStyle={markdownStyle()}
                            fg={palette().text}
                          />
                        </box>
                      </Show>
                    </box>
                  )}
                </Match>
                <Match when={asText(line)}>
                  {(text) => (
                    <Switch>
                      <Match when={text().kind === "user"}>
                        <box flexDirection="row" marginBottom={1}>
                          <text fg={palette().accent} flexShrink={0}>
                            {"❯"}
                          </text>
                          <box flexGrow={1} flexShrink={1} marginLeft={1}>
                            <text fg={palette().text}>{text().text}</text>
                          </box>
                        </box>
                      </Match>
                      <Match when={text().kind === "assistant"}>
                        <box flexDirection="row" marginBottom={1}>
                          {/* The markdown box grows; the bullet must not shrink to fit. */}
                          <text fg={palette().text} flexShrink={0}>
                            {"⏺"}
                          </text>
                          <box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={1}>
                            <markdown
                              content={text().text}
                              syntaxStyle={markdownStyle()}
                              fg={palette().text}
                              streaming={state.busy && line === state.lines.at(-1)}
                              internalBlockMode="top-level"
                            />
                            <Show when={responseInfo(text())}>
                              {(info) => (
                                <text fg={palette().muted} wrapMode="none" truncate>
                                  {info().model} · {formatTokensPerSecond(info().tokensPerSecond)}{" "}
                                  tokens/s
                                </text>
                              )}
                            </Show>
                          </box>
                        </box>
                      </Match>
                      <Match when={true}>
                        <box flexDirection="row" marginBottom={1}>
                          <text fg={lineColour(palette(), text())}>{"⏺ "}</text>
                          <box flexGrow={1} flexShrink={1}>
                            <text fg={lineColour(palette(), text())}>{text().text}</text>
                          </box>
                        </box>
                      </Match>
                    </Switch>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </scrollbox>
        <Show when={dialog()}>
          {(open) => (
            <PickerView
              picker={open().picker}
              palette={palette()}
              onDone={(picked) => open().done(picked)}
            />
          )}
        </Show>
        <Show when={active()}>
          <box flexDirection="row" flexShrink={0} paddingLeft={1}>
            <text fg={palette().accent}>{frame()} </text>
            <text fg={palette().text}>{state.status} </text>
            <text fg={palette().muted}>
              {state.busy
                ? `(esc to interrupt · ${formatDuration(elapsed())})`
                : `(${formatDuration(elapsed())})`}
            </text>
          </box>
        </Show>
        <Show when={queue().length > 0}>
          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
            <For each={queue()}>
              {(item) => (
                <text fg={palette().muted} wrapMode="none" truncate>
                  {"❯ "}
                  {clip(item.draft)}
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show when={popover()}>
          {(listed) => (
            // A row of no height right above the composer; the list hangs off
            // its bottom edge, so it floats over the transcript instead of
            // pushing it up.
            <box height={0} flexShrink={0}>
              <box
                position="absolute"
                bottom={0}
                left={0}
                right={0}
                zIndex={1}
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={palette().panel}
              >
                <Show
                  when={listed().items.length > 0}
                  fallback={
                    <text fg={palette().muted} wrapMode="none" truncate>
                      {listed().loading ? "  finding files…" : "  no matching files"}
                    </text>
                  }
                >
                  <For each={listed().items}>
                    {(suggestion, index) => (
                      <box flexDirection="row">
                        <text
                          fg={index() === selected() ? palette().accent : palette().text}
                          wrapMode="none"
                          truncate
                          flexShrink={suggestion.kind === "file" ? 1 : 0}
                        >
                          {index() === selected() ? "❯ " : "  "}
                          {suggestion.kind === "command"
                            ? `/${suggestion.command.name}`
                            : `@${suggestion.path}`}
                        </text>
                        <Show
                          when={
                            suggestion.kind === "command"
                              ? suggestion.command.description
                              : undefined
                          }
                        >
                          {(description) => (
                            <text
                              fg={palette().muted}
                              wrapMode="none"
                              truncate
                              flexShrink={1}
                              marginLeft={2}
                            >
                              {description()}
                            </text>
                          )}
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </box>
          )}
        </Show>
        <box
          border={["top", "bottom"]}
          borderStyle="single"
          borderColor={palette().border}
          flexDirection="row"
          flexShrink={0}
          paddingLeft={1}
        >
          <text fg={palette().text} marginLeft={-2}>
            {"❯ "}
          </text>
          <textarea
            ref={(node: TextareaRenderable) => {
              composer = node;
            }}
            focused={dialog() === undefined}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            marginRight={1}
            height={rows()}
            wrapMode="word"
            keyBindings={COMPOSER_KEYS}
            syntaxStyle={composerStyleFor(palette())}
            textColor={palette().text}
            focusedTextColor={palette().text}
            cursorColor={palette().text}
            placeholderColor={palette().placeholder}
            placeholder={
              state.busy
                ? "Message the agent; it reads it before its next step"
                : "Message the agent"
            }
            onContentChange={onDraft}
            onCursorChange={() => setCursor(composer?.cursorOffset ?? 0)}
            onSubmit={submit}
          />
        </box>
        <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <box flexDirection="row">
            {Option.match(modelParts(), {
              onNone: () => (
                <text fg={palette().muted} wrapMode="none" truncate>
                  no model signed in
                </text>
              ),
              onSome: ({ provider, model }) => (
                <text fg={palette().muted} wrapMode="none" truncate>
                  {provider}/<strong style={{ fg: palette().text }}>{model}</strong>
                </text>
              ),
            })}
            <Show when={Option.getOrUndefined(state.reasoning)}>
              {(level) => (
                <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                  {" · "}
                  <strong style={{ fg: palette().accent }}>{level()}</strong>
                </text>
              )}
            </Show>
            <Show when={contextInfo()}>
              {(info) => (
                <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                  {" · "}
                  {info()}
                </text>
              )}
            </Show>
            <Show when={Option.getOrUndefined(Option.filter(state.cost, (spent) => spent > 0))}>
              {(spent) => (
                <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                  {" · "}
                  {formatCost(spent())}
                </text>
              )}
            </Show>
            <Show when={state.tasks > 0}>
              <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                {" · "}
                <strong style={{ fg: palette().accent }}>{state.tasks}</strong>
                {state.tasks === 1 ? " task running" : " tasks running"}
              </text>
            </Show>
            <Show when={Option.getOrUndefined(state.driver)}>
              {(driver) => (
                <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                  {" · "}
                  <strong style={{ fg: palette().accent }}>{driver().label}</strong>
                  {state.busy ? "" : ` · next in ${remaining()}`}
                </text>
              )}
            </Show>
          </box>
          {/* The left half is free for later; the hint keeps to the right. */}
          <box flexDirection="row" justifyContent="flex-end">
            <Show
              when={armed() ? "ctrl+c again to quit" : flash()}
              fallback={
                <text fg={palette().muted} wrapMode="none" truncate>
                  {hint()}
                </text>
              }
            >
              {(notice) => (
                <text fg={palette().accent} wrapMode="none" truncate>
                  {notice()}
                </text>
              )}
            </Show>
          </box>
        </box>
      </box>
    );
  };

  return {
    view,
    apply,
    addUser: (text) => push({ kind: "user", text }),
    note: (text) => push({ kind: "note", text }),
    error: (text) => push({ kind: "error", text }),
    setModel: (ref, contextWindow) => setState({ model: Option.some(ref), contextWindow }),
    setReasoning: (level) => setState("reasoning", level),
    flash: (text) => showFlash(text),
    pick,
    dismiss,
    restore: (entries, contextTokens, cost) =>
      setState({ lines: entries.map(toLine), contextTokens, cost, status: "", tasks: 0 }),
    reset: () =>
      setState({ lines: [], contextTokens: 0, cost: Option.none(), status: "", tasks: 0 }),
    interrupted: () => {
      // No event follows a stop, so a thought in progress is folded here.
      finishThinking();
      push({ kind: "error", text: "Interrupted" });
    },
    setStatus: (status) => setState("status", status),
    setBusy: (busy) => {
      setState("busy", busy);
      if (!busy) {
        flushQueue();
      }
    },
    setTasks: (running) => setState("tasks", running),
    setDriver: (driver) => setState("driver", driver),
  };
};
