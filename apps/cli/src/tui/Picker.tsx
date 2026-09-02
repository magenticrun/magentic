import type { Picked, Picker, PickItem } from "@magentic/plugin";
import { useKeyboard } from "@opentui/solid";
import { Option } from "effect";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
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

const isEnter = (name: string) => name === "return" || name === "kpenter" || name === "linefeed";

/**
 * A picker drawn in the chat: sections, a cursor, a detail column at the
 * right, and one keystroke per action. Answers once, through `onDone`.
 */
export const PickerView = (props: {
  readonly picker: Picker;
  readonly palette: Palette;
  readonly onDone: (picked: Option.Option<Picked>) => void;
}) => {
  const rows = createMemo(() => flatten(props.picker));
  const items = createMemo(() => rows().flatMap((row) => (row.kind === "item" ? [row.item] : [])));
  const start = Math.max(
    0,
    items().findIndex((item) => item.id === props.picker.cursor),
  );
  const [cursor, setCursor] = createSignal(start);
  // Open with the starting row in the middle, so there is context both ways.
  const [top, setTop] = createSignal(
    Math.max(0, Math.min(start + 1 - Math.floor(MAX_ROWS / 2), rows().length - MAX_ROWS)),
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

  useKeyboard((key) => {
    // Global handlers run before the focused renderable's; without this the
    // key that closes the dialog would also land in the composer it refocuses.
    key.preventDefault();
    const count = items().length;
    if (key.name === "escape") {
      props.onDone(Option.none());
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
    const item = items()[cursor()];
    if (item === undefined) {
      return;
    }
    if (isEnter(key.name)) {
      props.onDone(Option.some({ id: item.id, action: Option.none() }));
      return;
    }
    if (key.ctrl || key.meta) {
      return;
    }
    const action = props.picker.actions?.find((a) => a.key === key.name);
    if (action !== undefined) {
      props.onDone(Option.some({ id: item.id, action: Option.some(action.key) }));
    }
  });

  const hints = () =>
    [
      "↑↓ move",
      "enter choose",
      ...(props.picker.actions ?? []).map((a) => `${a.key} ${a.label}`),
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
      <Show when={hiddenAbove() > 0}>
        <text fg={props.palette.muted}>{`  ↑ ${hiddenAbove()} more`}</text>
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
