import { SyntaxStyle } from "@opentui/core";
import type { Palette } from "./Theme.ts";

/**
 * How OpenTUI's markdown renderer colours what the agent writes. The names
 * are the tree-sitter captures of its bundled markdown and code grammars;
 * whatever has no entry falls back to `default`.
 */
const stylesFor = (colours: Palette) => ({
  default: { fg: colours.text },
  conceal: { fg: colours.muted, dim: true },
  // A name falls back to its first segment only, so each heading level is spelled out.
  "markup.heading": { fg: colours.accent, bold: true },
  "markup.heading.1": { fg: colours.accent, bold: true },
  "markup.heading.2": { fg: colours.accent, bold: true },
  "markup.heading.3": { fg: colours.accent, bold: true },
  "markup.heading.4": { fg: colours.accent, bold: true },
  "markup.heading.5": { fg: colours.accent, bold: true },
  "markup.heading.6": { fg: colours.accent, bold: true },
  "markup.strong": { fg: colours.text, bold: true },
  "markup.italic": { fg: colours.text, italic: true },
  "markup.strikethrough": { fg: colours.muted, dim: true },
  "markup.raw": { fg: colours.type },
  "markup.raw.block": { fg: colours.text },
  "markup.list": { fg: colours.accent },
  "markup.list.checked": { fg: colours.success },
  "markup.list.unchecked": { fg: colours.muted },
  "markup.quote": { fg: colours.muted, italic: true },
  "markup.link": { fg: colours.type, underline: true },
  "markup.link.label": { fg: colours.type },
  "markup.link.url": { fg: colours.muted, underline: true },
  "punctuation.delimiter": { fg: colours.muted },
  "punctuation.special": { fg: colours.muted },
  "punctuation.bracket": { fg: colours.muted },
  keyword: { fg: colours.keyword },
  "keyword.directive": { fg: colours.keyword },
  string: { fg: colours.string },
  "string.escape": { fg: colours.keyword },
  "string.regexp": { fg: colours.string },
  comment: { fg: colours.comment, italic: true },
  type: { fg: colours.type },
  "type.builtin": { fg: colours.type },
  function: { fg: colours.text, bold: true },
  "function.method": { fg: colours.text, bold: true },
  number: { fg: colours.string },
  boolean: { fg: colours.keyword },
  constant: { fg: colours.keyword },
  operator: { fg: colours.muted },
  variable: { fg: colours.text },
  "variable.parameter": { fg: colours.text, italic: true },
});

/** The same markup, all in the muted colour, for what the model thinks rather than says. */
const subtleStylesFor = (colours: Palette) =>
  Object.fromEntries(
    Object.entries(stylesFor(colours)).map(([name, style]) => [
      name,
      { ...style, fg: colours.muted },
    ]),
  );

// A SyntaxStyle is a native handle; one per palette lives as long as the process.
const cache = new Map<Palette, SyntaxStyle>();
const subtleCache = new Map<Palette, SyntaxStyle>();

const cached = (
  store: Map<Palette, SyntaxStyle>,
  colours: Palette,
  build: (colours: Palette) => SyntaxStyle,
): SyntaxStyle => {
  const known = store.get(colours);
  if (known !== undefined) {
    return known;
  }
  const built = build(colours);
  store.set(colours, built);
  return built;
};

/** The syntax style for a palette, built once. */
export const markdownStyleFor = (colours: Palette): SyntaxStyle =>
  cached(cache, colours, (c) => SyntaxStyle.fromStyles(stylesFor(c)));

/** The muted style for reasoning, built once. */
export const subtleStyleFor = (colours: Palette): SyntaxStyle =>
  cached(subtleCache, colours, (c) => SyntaxStyle.fromStyles(subtleStylesFor(c)));
