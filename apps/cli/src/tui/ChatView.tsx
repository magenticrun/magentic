import type { TextareaOptions, TextareaRenderable, ThemeMode } from "@opentui/core";
import type { RunEvent } from "@magentic/protocol";
import { type JSX, useKeyboard, useRenderer } from "@opentui/solid";
import { Option, Predicate, type Schema } from "effect";
import { batch, createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type Palette, paletteFor } from "./Theme.ts";

export type TextLine = {
  readonly kind: "user" | "assistant" | "error";
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

export type Line = TextLine | ToolLine;

/** Mutable on purpose: Solid's store setters address fields by name. */
type State = {
  agent: string;
  gateway: string;
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
const asText = (line: Line): TextLine | undefined => (line.kind === "tool" ? undefined : line);

export interface ChatTui {
  readonly view: () => JSX.Element;
  /** Fold one run event into the transcript. */
  apply(event: RunEvent): void;
  addUser(text: string): void;
  /** Note that the person stopped the run in flight. */
  interrupted(): void;
  setStatus(status: string): void;
  setBusy(busy: boolean): void;
}

export const createChatTui = (options: {
  readonly agent: string;
  readonly gateway: string;
  /** The `provider/model` the agent runs on, when the gateway could tell. */
  readonly model: Option.Option<string>;
  readonly onSubmit: (text: string) => void;
  /** Esc, or ctrl+c, while a run is in flight. */
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
}): ChatTui => {
  const [state, setState] = createStore<State>({
    agent: options.agent,
    gateway: options.gateway,
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

  const apply = (event: RunEvent) =>
    batch(() => {
      switch (event._tag) {
        case "RunStarted":
          setState("status", "Thinking…");
          return;
        case "TextDelta":
          appendAssistant(event.text);
          return;
        case "ReasoningDelta":
          setState("status", "Reasoning…");
          return;
        case "ToolCall":
          setState("status", `Running ${event.name}…`);
          push({ kind: "tool", name: event.name, params: summariseParams(event.params) });
          return;
        case "ToolResult":
          setState("status", "Thinking…");
          finishTool(event.name, { ok: !event.isFailure, text: summarise(event.result) });
          return;
        case "RunFinished":
          setState("status", "");
          return;
        case "RunFailed":
          setState("status", "");
          push({ kind: "error", text: event.message });
          return;
      }
    });

  const view = () => {
    // A first ctrl+c arms quitting for a moment; only a second one quits.
    const [armed, setArmed] = createSignal(false);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(disarm));
    useKeyboard((key) => {
      if (key.name === "escape") {
        if (state.busy) {
          options.onInterrupt();
        }
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

    // Ticks since the run began; drives the spinner and the elapsed seconds.
    const [ticks, setTicks] = createSignal(0);
    createEffect(() => {
      if (!state.busy) {
        return;
      }
      setTicks(0);
      const timer = setInterval(() => setTicks((n) => n + 1), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });
    const frame = () => FRAMES[ticks() % FRAMES.length];
    const elapsed = () => Math.floor((ticks() * TICK_MS) / 1000);

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
    const submit = () => {
      if (composer === undefined) {
        return;
      }
      const text = composer.plainText.trim();
      if (text.length === 0 || state.busy) {
        return;
      }
      options.onSubmit(text);
      composer.setText("");
      setRows(1);
    };

    const bullet = (colours: Palette, line: ToolLine) =>
      line.result === undefined ? colours.muted : line.result.ok ? colours.success : colours.error;

    return (
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} flexShrink={1} marginTop={1}>
          <box
            border
            borderStyle="rounded"
            borderColor={palette().accent}
            alignSelf="flex-start"
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            marginBottom={1}
          >
            <text fg={palette().text}>
              <span style={{ fg: palette().accent }}>✻</span> <strong>magentic</strong> ·{" "}
              {state.agent}
            </text>
            <text fg={palette().muted}>{state.gateway}</text>
          </box>
          <For each={state.lines}>
            {(line) => (
              <Switch>
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
                        <box
                          alignSelf="flex-start"
                          backgroundColor={palette().surface}
                          paddingLeft={1}
                          paddingRight={1}
                          marginBottom={1}
                        >
                          <text fg={palette().muted}>
                            {"> "}
                            {text().text}
                          </text>
                        </box>
                      </Match>
                      <Match when={true}>
                        <box flexDirection="row" marginBottom={1}>
                          <text fg={text().kind === "error" ? palette().error : palette().text}>
                            {"⏺ "}
                          </text>
                          <box flexGrow={1} flexShrink={1}>
                            <text fg={text().kind === "error" ? palette().error : palette().text}>
                              {text().text}
                            </text>
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
        <Show when={state.busy}>
          <box flexDirection="row" flexShrink={0} paddingLeft={1}>
            <text fg={palette().accent}>{frame()} </text>
            <text fg={palette().text}>{state.status} </text>
            <text fg={palette().muted}>(esc to interrupt · {elapsed()}s)</text>
          </box>
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
            focused
            flexGrow={1}
            height={rows()}
            wrapMode="word"
            keyBindings={COMPOSER_KEYS}
            textColor={palette().text}
            focusedTextColor={palette().text}
            cursorColor={palette().text}
            placeholderColor={palette().placeholder}
            placeholder={state.busy ? "Waiting for the agent…" : "Message the agent"}
            onContentChange={fitRows}
            onSubmit={submit}
          />
        </box>
        <box
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
        >
          <Show
            when={armed()}
            fallback={
              <text fg={palette().muted} wrapMode="none" truncate flexShrink={1}>
                shift+enter newline
              </text>
            }
          >
            <text fg={palette().accent} wrapMode="none" truncate flexShrink={1}>
              ctrl+c again to quit
            </text>
          </Show>
          <text fg={palette().text} wrapMode="none" flexShrink={0} marginLeft={1}>
            {state.agent} <span style={{ fg: palette().muted }}>agent · </span>
            {Option.match(options.model, {
              onNone: () => <span style={{ fg: palette().muted }}>no model signed in</span>,
              onSome: (ref) => ref,
            })}
          </text>
        </box>
      </box>
    );
  };

  return {
    view,
    apply,
    addUser: (text) => push({ kind: "user", text }),
    interrupted: () => push({ kind: "error", text: "Interrupted" }),
    setStatus: (status) => setState("status", status),
    setBusy: (busy) => setState("busy", busy),
  };
};
