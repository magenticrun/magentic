import type { ThemeMode } from "@opentui/core";

/**
 * The colours the chat draws with. Text and chrome follow the terminal's
 * theme; the accent is the same warm orange on both so the chat is
 * recognisable at a glance.
 */
export interface Palette {
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly placeholder: string;
  /** Logo, spinner and the welcome frame. */
  readonly accent: string;
  /** Background behind what the person typed. */
  readonly surface: string;
  readonly success: string;
  readonly error: string;
}

const dark: Palette = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  placeholder: "#6b7280",
  accent: "#d97757",
  surface: "#27272a",
  success: "#86efac",
  error: "#fca5a5",
};

const light: Palette = {
  text: "#1f2937",
  muted: "#6b7280",
  border: "#9ca3af",
  placeholder: "#9ca3af",
  accent: "#c2410c",
  surface: "#e5e7eb",
  success: "#15803d",
  error: "#b91c1c",
};

/** Dark when the terminal never answered the theme query, as most terminals are dark. */
export const paletteFor = (mode: ThemeMode | null): Palette => (mode === "light" ? light : dark);
