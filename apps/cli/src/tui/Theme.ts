import type { ThemeMode } from "@opentui/core";

/**
 * The colours the chat draws with. Text and chrome follow the terminal's
 * theme; the accent is the brand orange on both so the chat is
 * recognisable at a glance.
 */
export interface Palette {
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly placeholder: string;
  /** The dot in the logo, the spinner and the welcome frame. */
  readonly accent: string;
  readonly success: string;
  readonly error: string;
  /** Keywords in fenced code. */
  readonly keyword: string;
  /** String literals in fenced code. */
  readonly string: string;
  /** Comments in fenced code. */
  readonly comment: string;
  /** Types, and inline code in prose. */
  readonly type: string;
}

/** The orange of the dot in the logo. */
const BRAND = "#d95f21";

const dark: Palette = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  placeholder: "#6b7280",
  accent: BRAND,
  success: "#86efac",
  error: "#fca5a5",
  keyword: "#c4b5fd",
  string: "#a5d6a7",
  comment: "#6b7280",
  type: "#7dd3fc",
};

const light: Palette = {
  text: "#1f2937",
  muted: "#6b7280",
  border: "#9ca3af",
  placeholder: "#9ca3af",
  accent: BRAND,
  success: "#15803d",
  error: "#b91c1c",
  keyword: "#6d28d9",
  string: "#15803d",
  comment: "#9ca3af",
  type: "#0369a1",
};

/** Dark when the terminal never answered the theme query, as most terminals are dark. */
export const paletteFor = (mode: ThemeMode | null): Palette => (mode === "light" ? light : dark);
