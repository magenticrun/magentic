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
import { Option, Predicate, type Schema } from "effect";
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
import { createStore, produce } from "solid-js/store";
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

export type TextLine = {
  /**
   * A note is what a command reports, in the transcript but not from the
   * agent. A summary is what a compaction left for the model to continue from.
   */
  readonly kind: "user" | "assistant" | "error" | "note" | "summary";
  readonly text: string;
};

export type ToolResult = { readonly ok: boolean; readonly text: string };

export type ToolLine = {
  readonly kind: "tool";
  readonly name: string;
  readonly params: string;
  /** Absent while the tool is still running. */
  readonly result?: ToolResult;
};

/**
 * What the model thought before it answered, shown as it streams and folded
 * to one line once it has, the way opencode does. Measured in ticks of the
 * run's clock, since that is what the footer counts too.
 */
export type ThinkingLine = {
  readonly kind: "thinking";
  readonly text: string;
  readonly startedTick: number;
  /** Absent while the model is still thinking. */
  readonly endedTick?: number;
  /** Whether the person opened the folded text again. */
  readonly expanded: boolean;
};

export type Line = TextLine | ToolLine | ThinkingLine;

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
  /** What the agent is doing right now; only shown while busy. */
  status: string;
  lines: Array<Line>;
  busy: boolean;
};

/** The frames Claude Code's spinner walks through, out and back. */
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✶", "✳", "✢"];
const TICK_MS = 100;
/** How long a first ctrl+c waits for the second before it is forgotten. */
const CONFIRM_MS = 2000;
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
  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(1))}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1000)}k`;
  }
  return count >= 1000 ? `${Number((count / 1000).toFixed(1))}k` : `${count}`;
};

const isEnter = (name: string) => name === "return" || name === "kpenter" || name === "linefeed";

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
const asText = (line: Line): TextLine | undefined =>
  line.kind === "tool" || line.kind === "thinking" ? undefined : line;

/** `Thought for 12s`; a thought shorter than a second still took one. */
const thoughtFor = (line: ThinkingLine): string => {
  const ticks = (line.endedTick ?? line.startedTick) - line.startedTick;
  return `Thought for ${Math.max(1, Math.round((ticks * TICK_MS) / 1000))}s`;
};

/** What the slash-command popover lists. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
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
  /** Show a picker over the composer; `done` gets the answer. A second `pick` replaces it. */
  pick(picker: Picker, done: (picked: Option.Option<Picked>) => void): void;
  /** Close the picker, if one is open: the command that asked has ended. */
  dismiss(): void;
  /** Replace the transcript with an earlier conversation's, and the context it last held. */
  restore(entries: ReadonlyArray<TranscriptEntry>, contextTokens: number): void;
  /** Clear the transcript for a new conversation. */
  reset(): void;
  /** Note that the person stopped the run in flight. */
  interrupted(): void;
  setStatus(status: string): void;
  setBusy(busy: boolean): void;
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
  /** The message with pasted text unfolded, and the images pasted into it. */
  readonly onSubmit: (text: string, attachments: ReadonlyArray<Attachment>) => void;
  /** Esc, or ctrl+c, while a run is in flight. */
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
}): ChatTui => {
  const [state, setState] = createStore<State>({
    model: options.model,
    ticks: 0,
    contextTokens: 0,
    contextWindow: options.contextWindow,
    status: "",
    lines: [],
    busy: false,
  });

  const push = (line: Line) =>
    setState(
      produce((s) => {
        s.lines = [...s.lines, line];
      }),
    );

  const appendAssistant = (text: string) =>
    setState(
      produce((s) => {
        const last = s.lines.at(-1);
        if (last !== undefined && last.kind === "assistant") {
          s.lines = [...s.lines.slice(0, -1), { kind: "assistant", text: last.text + text }];
        } else {
          s.lines = [...s.lines, { kind: "assistant", text }];
        }
      }),
    );

  /** Attach a result to the newest unfinished call of that tool. */
  const finishTool = (name: string, result: ToolResult) =>
    setState(
      produce((s) => {
        for (let i = s.lines.length - 1; i >= 0; i--) {
          const line = s.lines[i];
          if (
            line !== undefined &&
            line.kind === "tool" &&
            line.name === name &&
            line.result === undefined
          ) {
            s.lines = [...s.lines.slice(0, i), { ...line, result }, ...s.lines.slice(i + 1)];
            return;
          }
        }
        s.lines = [...s.lines, { kind: "tool", name, params: "", result }];
      }),
    );

  /** Grow the thought in progress, or begin one. */
  const appendThinking = (text: string) =>
    setState(
      produce((s) => {
        const last = s.lines.at(-1);
        if (last !== undefined && last.kind === "thinking" && last.endedTick === undefined) {
          s.lines = [...s.lines.slice(0, -1), { ...last, text: last.text + text }];
        } else {
          s.lines = [...s.lines, { kind: "thinking", text, startedTick: s.ticks, expanded: false }];
        }
      }),
    );

  /** The model moved on from thinking; fold the thought. */
  const finishThinking = () =>
    setState(
      produce((s) => {
        const last = s.lines.at(-1);
        if (last !== undefined && last.kind === "thinking" && last.endedTick === undefined) {
          s.lines = [...s.lines.slice(0, -1), { ...last, endedTick: s.ticks }];
        }
      }),
    );

  const toggleThinking = (index: number) =>
    setState(
      produce((s) => {
        const line = s.lines[index];
        if (line !== undefined && line.kind === "thinking") {
          s.lines = [
            ...s.lines.slice(0, index),
            { ...line, expanded: !line.expanded },
            ...s.lines.slice(index + 1),
          ];
        }
      }),
    );

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

  const apply = (event: RunEvent) =>
    batch(() => {
      // Anything but more reasoning means the model has finished thinking.
      if (event._tag !== "ReasoningDelta") {
        finishThinking();
      }
      switch (event._tag) {
        case "RunStarted":
          setState("status", "Thinking…");
          return;
        case "TextDelta":
          appendAssistant(event.text);
          return;
        case "ReasoningDelta":
          appendThinking(event.text);
          return;
        case "ToolCall":
          setState("status", `Running ${event.name}…`);
          push({ kind: "tool", name: event.name, params: summariseParams(event.params) });
          return;
        case "ToolResult":
          setState("status", "Thinking…");
          finishTool(event.name, { ok: !event.isFailure, text: summarise(event.result) });
          return;
        case "TokenUsage":
          setState("contextTokens", event.inputTokens + event.outputTokens);
          return;
        case "CompactionStarted":
          setState("status", "Compacting…");
          return;
        case "Compacted":
          // Earlier lines stay on screen; the model continues from the summary.
          push({ kind: "summary", text: event.summary });
          push({
            kind: "note",
            text: `Compacted ${event.messagesBefore} messages into a summary`,
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
        return { kind: "summary", text: entry.text };
      case "Tool": {
        const call: ToolLine = {
          kind: "tool",
          name: entry.name,
          params: summariseParams(entry.params),
        };
        return entry.result === undefined
          ? call
          : { ...call, result: { ok: !entry.isFailure, text: summarise(entry.result) } };
      }
    }
  };

  const view = () => {
    // A first ctrl+c arms quitting for a moment; only a second one quits.
    const [armed, setArmed] = createSignal(false);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(disarm));
    // A word in the footer for a moment, such as that a selection was copied.
    const [flash, setFlash] = createSignal<string | undefined>(undefined);
    let unflash: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(unflash));
    const showFlash = (text: string) => {
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
        const count = listed.length;
        const chosen = listed[selected()];
        if (key.name === "up") {
          setSelected((n) => (n - 1 + count) % count);
        } else if (key.name === "down") {
          setSelected((n) => (n + 1) % count);
        } else if (key.name === "tab" && chosen !== undefined) {
          complete(chosen);
        } else if (isEnter(key.name) && chosen !== undefined && !state.busy) {
          options.onSubmit(`/${chosen.name}`, []);
          clear();
        } else if (key.name === "escape") {
          setDismissed(true);
        } else {
          return;
        }
        // Handled here; the composer must not also insert or submit.
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        if (state.busy && dialog() === undefined) {
          options.onInterrupt();
        }
        return;
      }
      if (key.ctrl && key.name === "v" && dialog() === undefined) {
        // The terminal pastes text itself; ctrl+v is for what it cannot paste, an image.
        key.preventDefault();
        void pasteClipboard();
        return;
      }
      if (key.ctrl && key.name === "c") {
        if (armed()) {
          options.onExit();
          return;
        }
        if (state.busy) {
          options.onInterrupt();
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

    // Ticks since the run began; drives the spinner, the elapsed seconds, and
    // how long each thought took.
    createEffect(() => {
      if (!state.busy) {
        return;
      }
      setState("ticks", 0);
      const timer = setInterval(() => setState("ticks", (n) => n + 1), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
    const frame = () => FRAMES[state.ticks % FRAMES.length];
    const elapsed = () => Math.floor((state.ticks * TICK_MS) / 1000);

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
    };
    const submit = () => {
      if (composer === undefined) {
        return;
      }
      const draft = composer.plainText.trim();
      if (draft.length === 0 || state.busy || dialog() !== undefined) {
        return;
      }
      options.onSubmit(unfold(draft, folds), attached(draft, folds));
      clear();
    };

    /** Put a placeholder at the cursor, styled and moved over as one unit. */
    const fold = (entry: Folded) => {
      if (composer === undefined) {
        return;
      }
      const start = composer.cursorOffset;
      composer.insertText(`${entry.placeholder} `);
      const range = { start, end: start + entry.placeholder.length, virtual: true };
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
      const index = folds.filter((f) => f.kind === "text").length + 1;
      fold({ kind: "text", placeholder: textPlaceholder(index, text), text });
    };
    const attach = (attachment: Attachment) => {
      const index = folds.filter((f) => f.kind === "file").length + 1;
      fold({ kind: "file", placeholder: imagePlaceholder(index), attachment });
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
    const [dismissed, setDismissed] = createSignal(false);
    const [selected, setSelected] = createSignal(0);
    const suggestions = createMemo(() => {
      const text = draft();
      if (!text.startsWith("/") || /\s/.test(text)) {
        return [];
      }
      const prefix = text.slice(1);
      return options.commands.filter((command) => command.name.startsWith(prefix));
    });
    createEffect(() => {
      suggestions();
      setDismissed(false);
      setSelected(0);
    });
    /** The footer shows the provider and model apart; a bare provider means its default model. */
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
    const popover = () =>
      dialog() === undefined && !dismissed() && suggestions().length > 0
        ? suggestions()
        : undefined;
    const onDraft = () => {
      fitRows();
      setDraft(composer?.plainText ?? "");
    };
    const complete = (command: CommandInfo) => {
      if (composer === undefined) {
        return;
      }
      const text = `/${command.name} `;
      composer.setText(text);
      composer.cursorOffset = text.length;
      setDraft(text);
    };

    const bullet = (colours: Palette, line: ToolLine) =>
      line.result === undefined ? colours.muted : line.result.ok ? colours.success : colours.error;
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
                      {/* Click the header to open a folded thought again, or fold it. */}
                      <box
                        flexDirection="row"
                        onMouseUp={() => {
                          if (!selecting()) {
                            toggleThinking(index());
                          }
                        }}
                      >
                        <text fg={palette().muted} flexShrink={0}>
                          {thought().endedTick === undefined ? frame() : "⏺"}
                        </text>
                        <text fg={palette().muted} marginLeft={1} wrapMode="none">
                          {thought().endedTick === undefined ? "Thinking…" : thoughtFor(thought())}
                        </text>
                      </box>
                      <Show when={thought().endedTick === undefined || thought().expanded}>
                        <box marginLeft={2}>
                          <markdown
                            content={thought().text}
                            syntaxStyle={subtleStyleFor(palette())}
                            fg={palette().muted}
                            streaming={thought().endedTick === undefined}
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
                      </box>
                    </box>
                  )}
                </Match>
                <Match when={asText(line)}>
                  {(text) => (
                    <Switch>
                      <Match when={text().kind === "user"}>
                        <box flexDirection="row" marginBottom={1}>
                          <text fg={palette().muted} flexShrink={0}>
                            {">"}
                          </text>
                          <box flexGrow={1} flexShrink={1} marginLeft={1}>
                            <text fg={palette().muted}>{text().text}</text>
                          </box>
                        </box>
                      </Match>
                      <Match when={text().kind === "assistant" || text().kind === "summary"}>
                        <box flexDirection="row" marginBottom={1}>
                          {/* The markdown box grows; the bullet must not shrink to fit. */}
                          <text
                            fg={text().kind === "summary" ? palette().muted : palette().text}
                            flexShrink={0}
                          >
                            {text().kind === "summary" ? "◐" : "⏺"}
                          </text>
                          <box flexGrow={1} flexShrink={1} marginLeft={1}>
                            <markdown
                              content={text().text}
                              syntaxStyle={markdownStyle()}
                              fg={palette().text}
                              streaming={state.busy && line === state.lines.at(-1)}
                            />
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
        <Show when={state.busy}>
          <box flexDirection="row" flexShrink={0} paddingLeft={1}>
            <text fg={palette().accent}>{frame()} </text>
            <text fg={palette().text}>{state.status} </text>
            <text fg={palette().muted}>(esc to interrupt · {elapsed()}s)</text>
          </box>
        </Show>
        <Show when={popover()}>
          {(listed) => (
            <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
              <For each={listed()}>
                {(command, index) => (
                  <box flexDirection="row">
                    <text
                      fg={index() === selected() ? palette().accent : palette().text}
                      wrapMode="none"
                      flexShrink={0}
                    >
                      {index() === selected() ? "❯ " : "  "}/{command.name}
                    </text>
                    <text
                      fg={palette().muted}
                      wrapMode="none"
                      truncate
                      flexShrink={1}
                      marginLeft={2}
                    >
                      {command.description}
                    </text>
                  </box>
                )}
              </For>
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
          <text fg={palette().text}>{"> "}</text>
          <textarea
            ref={(node: TextareaRenderable) => {
              composer = node;
            }}
            focused={dialog() === undefined}
            flexGrow={1}
            height={rows()}
            wrapMode="word"
            keyBindings={COMPOSER_KEYS}
            syntaxStyle={composerStyleFor(palette())}
            textColor={palette().text}
            focusedTextColor={palette().text}
            cursorColor={palette().text}
            placeholderColor={palette().placeholder}
            placeholder={state.busy ? "Waiting for the agent…" : "Message the agent"}
            onContentChange={onDraft}
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
                  {provider} · <strong style={{ fg: palette().text }}>{model}</strong>
                </text>
              ),
            })}
            <Show when={contextInfo()}>
              {(info) => (
                <text fg={palette().muted} wrapMode="none" flexShrink={0}>
                  {" · "}
                  {info()}
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
                  shift+enter newline · pgup/pgdn scroll
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
    pick,
    dismiss,
    restore: (entries, contextTokens) =>
      setState({ lines: entries.map(toLine), contextTokens, status: "" }),
    reset: () => setState({ lines: [], contextTokens: 0, status: "" }),
    interrupted: () => push({ kind: "error", text: "Interrupted" }),
    setStatus: (status) => setState("status", status),
    setBusy: (busy) => setState("busy", busy),
  };
};
