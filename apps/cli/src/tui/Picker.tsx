import type { Picked, Picker, PickItem } from "@magentic/plugin";
import { useKeyboard } from "@opentui/solid";
import { Option } from "effect";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { Palette } from "./Theme.ts";

/** Rows past this many scroll inside the dialog. */
const MAX_ROWS = 12;

type Row =
  | { readonly kind: "header"; readonly title: string }
  | { readonly kind: "item"; readonly item: PickItem; readonly index: number };

/** Section titles and their items as one list, so the cursor and the viewport share an index. */
const flatten = (picker: Picker): ReadonlyArray<Row> => {
  const rows: Array<Row> = [];
  let index = 0;
  for (const section of picker.sections) {
    rows.push({ kind: "header", title: section.title });
    for (const item of section.items) {
      rows.push({ kind: "item", item, index });
      index += 1;
    }
  }
  return rows;
};

/** Every word typed appears in the row's label or detail, in any order, case aside. */
const matches = (item: PickItem, words: ReadonlyArray<string>): boolean => {
  const text = `${item.label} ${item.detail ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
};

/**
 * The rows a filter finds, without section titles: the listed items in their
 * order, then the unlisted ones. A listed row that is also unlisted (a
 * favourite) takes its unlisted place, so toggling it there does not move it.
 */
const search = (picker: Picker, query: string): ReadonlyArray<Row> => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const unlisted = picker.unlisted ?? [];
  const below = new Set(unlisted.map((item) => item.id));
  const listed = picker.sections.flatMap((s) => s.items).filter((item) => !below.has(item.id));
  const seen = new Set<string>();
  const rows: Array<Row> = [];
  for (const item of [...listed, ...unlisted]) {
    if (seen.has(item.id) || !matches(item, words)) {
      continue;
    }
    seen.add(item.id);
    rows.push({ kind: "item", item, index: rows.length });
  }
  return rows;
};

const isEnter = (name: string) => name === "return" || name === "kpenter" || name === "linefeed";

/** The character a key types, when it types one: no chord, and not a control code. */
const typed = (key: { sequence: string; ctrl: boolean; meta: boolean }): string | undefined => {
  if (key.ctrl || key.meta || key.sequence.length === 0) {
    return undefined;
  }
  const code = key.sequence.charCodeAt(0);
  return code < 32 || code === 127 ? undefined : key.sequence;
};

/**
 * A picker drawn in the chat: sections, a cursor, a detail column at the
 * right, a filter that typing fills, and one keystroke per action. Answers
 * through `onDone`; a new `picker` prop is the next question, drawn in the
 * same frame.
 */
export const PickerView = (props: {
  readonly picker: Picker;
  readonly palette: Palette;
  readonly onDone: (picked: Option.Option<Picked>) => void;
}) => {
  const [query, setQuery] = createSignal("");
  const rows = createMemo(() =>
    query().length === 0 ? flatten(props.picker) : search(props.picker, query()),
  );
  const items = createMemo(() => rows().flatMap((row) => (row.kind === "item" ? [row.item] : [])));
  const start = createMemo(() =>
    Math.max(
      0,
      items().findIndex((item) => item.id === props.picker.cursor),
    ),
  );
  // Open with the starting row in the middle, so there is context both ways.
  const centred = () =>
    Math.max(0, Math.min(start() + 1 - Math.floor(MAX_ROWS / 2), rows().length - MAX_ROWS));
  const [cursor, setCursor] = createSignal(start());
  const [top, setTop] = createSignal(centred());

  // A replacement picker with the same title is this list redrawn (a favourite
  // toggled), so the filter and the viewport stay put; a different list opens
  // unfiltered and centred. Tracked by hand: a deferred `on` has no previous
  // input on its first run.
  let shown = props.picker;
  createEffect(
    on(
      () => props.picker,
      (picker) => {
        const previous = shown;
        shown = picker;
        if (previous.title !== picker.title) {
          setQuery("");
          setCursor(start());
          setTop(centred());
        } else {
          setCursor(start());
        }
      },
      { defer: true },
    ),
  );

  // Keep the cursor's row inside the window, with its section title when there is room.
  createEffect(() => {
    const at = rows().findIndex((row) => row.kind === "item" && row.index === cursor());
    if (at < top()) {
      const header = rows()[at - 1]?.kind === "header" ? 1 : 0;
      setTop(Math.max(0, at - header));
    } else if (at >= top() + MAX_ROWS) {
      setTop(at - MAX_ROWS + 1);
    }
  });
  const visible = createMemo(() => rows().slice(top(), top() + MAX_ROWS));
  const hiddenAbove = () => top();
  const hiddenBelow = () => Math.max(0, rows().length - top() - MAX_ROWS);

  // A new filter starts the list over at its first match.
  const filter = (next: string) => {
    setQuery(next);
    setCursor(0);
    setTop(0);
  };

  useKeyboard((key) => {
    // Global handlers run before the focused renderable's; without this the
    // key that closes the dialog would also land in the composer it refocuses.
    key.preventDefault();
    const count = items().length;
    if (key.name === "escape") {
      props.onDone(Option.none());
      return;
    }
    // A picker's own ctrl keys come first, or one on p or n could never be pressed.
    const action =
      key.ctrl && !key.meta ? props.picker.actions?.find((a) => a.key === key.name) : undefined;
    if (action !== undefined) {
      const item = items()[cursor()];
      if (item !== undefined) {
        props.onDone(Option.some({ id: item.id, action: Option.some(action.key) }));
      }
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setCursor((n) => (count === 0 ? 0 : (n - 1 + count) % count));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setCursor((n) => (count === 0 ? 0 : (n + 1) % count));
      return;
    }
    if (key.name === "backspace") {
      if (query().length > 0) {
        filter([...query()].slice(0, -1).join(""));
      }
      return;
    }
    const character = typed(key);
    if (character !== undefined) {
      filter(query() + character);
      return;
    }
    const item = items()[cursor()];
    if (item === undefined) {
      return;
    }
    if (isEnter(key.name)) {
      props.onDone(Option.some({ id: item.id, action: Option.none() }));
      return;
    }
  });

  const hints = () =>
    [
      "↑↓ move",
      "enter choose",
      ...(props.picker.actions ?? []).map((a) => `ctrl+${a.key} ${a.label}`),
      "esc back",
    ].join(" · ");

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={props.palette.accent}
      title={` ${props.picker.title} `}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text
        fg={query().length > 0 ? props.palette.text : props.palette.muted}
        wrapMode="none"
        truncate
      >
        {query().length > 0 ? `⌕ ${query()}▏` : "⌕ type to filter"}
      </text>
      <Show when={hiddenAbove() > 0}>
        <text fg={props.palette.muted}>{`  ↑ ${hiddenAbove()} more`}</text>
      </Show>
      <Show when={rows().length === 0}>
        <text fg={props.palette.muted}>{"  no matches"}</text>
      </Show>
      <For each={visible()}>
        {(row) => (
          <Show
            when={row.kind === "item" ? row : undefined}
            fallback={
              <text fg={props.palette.muted}>
                <strong>{row.kind === "header" ? row.title : ""}</strong>
              </text>
            }
          >
            {(entry) => (
              <box flexDirection="row" justifyContent="space-between">
                <text
                  fg={entry().index === cursor() ? props.palette.accent : props.palette.text}
                  wrapMode="none"
                  truncate
                  flexShrink={1}
                >
                  {entry().index === cursor() ? "❯ " : "  "}
                  {entry().item.marked === true ? "★ " : "  "}
                  {entry().item.label}
                </text>
                <Show when={entry().item.detail}>
                  {(detail) => (
                    <text fg={props.palette.muted} wrapMode="none" flexShrink={0} marginLeft={2}>
                      {detail()}
                    </text>
                  )}
                </Show>
              </box>
            )}
          </Show>
        )}
      </For>
      <Show when={hiddenBelow() > 0}>
        <text fg={props.palette.muted}>{`  ↓ ${hiddenBelow()} more`}</text>
      </Show>
      <text fg={props.palette.muted} wrapMode="none" truncate marginTop={1}>
        {hints()}
      </text>
    </box>
  );
};
