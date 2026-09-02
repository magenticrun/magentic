import type { Palette } from "./Theme.ts";

/**
 * The magentic mark in three rows and five cells: a square frame whose right
 * edge breaks where the orange dot sits over it.
 */
export const Logo = (props: { readonly palette: Palette }) => (
  <box flexDirection="column" flexShrink={0}>
    <text fg={props.palette.text}>{"┏━━━┓"}</text>
    <text fg={props.palette.text}>
      {"┃   "}
      <span style={{ fg: props.palette.accent }}>●</span>
    </text>
    <text fg={props.palette.text}>{"┗━━━┛"}</text>
  </box>
);
