/**
 * Where `edit_file` puts its replacement. An exact match comes first; when
 * there is none, the text is looked for line by line with less and less
 * attention to whitespace, as opencode's replacer chain and pi's fuzzy edit
 * do, because a model that copied a block from a read often gets its
 * indentation or trailing spaces slightly wrong. A tolerant match must be
 * unique at the level it was found, and the replacement is re-indented to
 * the lines it lands on (after Hermes), so the file keeps its own style.
 */

/** How a match was found; `exact` unless whitespace had to be forgiven. */
type Strategy = "exact" | "trailing" | "indentation" | "trimmed";

/** Where the text goes in the file, and what goes there. */
export interface Span {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type Located =
  | { readonly _tag: "Found"; readonly strategy: Strategy; readonly spans: ReadonlyArray<Span> }
  /** One-based lines where the text starts, when it is there more than once. */
  | {
      readonly _tag: "Ambiguous";
      readonly strategy: Strategy;
      readonly lines: ReadonlyArray<number>;
    }
  | { readonly _tag: "Missing" };

/** Occurrences shown at most when a match is ambiguous. */
const SHOWN = 5;

/** The one-based line a character offset falls on. */
const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line += 1;
  }
  return line;
};

const exactOffsets = (text: string, needle: string): Array<number> => {
  const found: Array<number> = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
};

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? "";

/** The shortest indentation among lines with something on them. */
const commonIndent = (lines: ReadonlyArray<string>): string => {
  let shortest: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const indent = indentOf(line);
    if (shortest === undefined || indent.length < shortest.length) {
      shortest = indent;
    }
  }
  return shortest ?? "";
};

const dedent = (lines: ReadonlyArray<string>): Array<string> => {
  const indent = commonIndent(lines);
  return lines.map((line) =>
    line.startsWith(indent) ? line.slice(indent.length) : line.trimStart(),
  );
};

/** Line comparisons from least to most forgiving; each gets its own uniqueness check. */
const LINE_STRATEGIES: ReadonlyArray<{
  readonly strategy: Exclude<Strategy, "exact">;
  readonly prepare: (lines: ReadonlyArray<string>) => ReadonlyArray<string>;
}> = [
  { strategy: "trailing", prepare: (lines) => lines.map((line) => line.trimEnd()) },
  { strategy: "indentation", prepare: (lines) => dedent(lines).map((line) => line.trimEnd()) },
  { strategy: "trimmed", prepare: (lines) => lines.map((line) => line.trim()) },
];

/**
 * The replacement moved from the indentation the model wrote to the one the
 * matched lines have: each line loses the old common indentation and gains
 * the file's.
 */
const reindent = (
  replacement: string,
  written: ReadonlyArray<string>,
  found: ReadonlyArray<string>,
): string => {
  const from = commonIndent(written);
  const to = commonIndent(found);
  if (from === to) {
    return replacement;
  }
  return replacement
    .split("\n")
    .map((line) => {
      if (line.trim() === "") {
        return line;
      }
      return line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();
    })
    .join("\n");
};

/**
 * Where `oldString` is in `text`, and what replaces it. All three are in the
 * same line-ending convention. `replaceAll` takes every exact occurrence and
 * never a tolerant one, since a loose pattern repeated is how an edit lands
 * where nobody meant it to.
 */
export const locate = (
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Located => {
  const exact = exactOffsets(text, oldString);
  if (exact.length === 1 || (exact.length > 1 && replaceAll)) {
    return {
      _tag: "Found",
      strategy: "exact",
      spans: exact.map((start) => ({
        start,
        end: start + oldString.length,
        replacement: newString,
      })),
    };
  }
  if (exact.length > 1) {
    return {
      _tag: "Ambiguous",
      strategy: "exact",
      lines: exact.slice(0, SHOWN).map((at) => lineAt(text, at)),
    };
  }
  if (replaceAll) {
    return { _tag: "Missing" };
  }

  // Whole lines from here on. A trailing line break on the old text ends its
  // last line; the one on the new text goes with it.
  const endsLine = oldString.endsWith("\n");
  const oldBody = endsLine ? oldString.slice(0, -1) : oldString;
  const newBody = endsLine && newString.endsWith("\n") ? newString.slice(0, -1) : newString;
  const wanted = oldBody.split("\n");
  // Blank lines alone match anywhere, and are not worth guessing at.
  if (wanted.every((line) => line.trim() === "")) {
    return { _tag: "Missing" };
  }
  const lines = text.split("\n");
  /** Where each line starts in the text. */
  const starts: Array<number> = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  for (const { strategy, prepare } of LINE_STRATEGIES) {
    const target = prepare(wanted);
    const hits: Array<number> = [];
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      const window = prepare(lines.slice(i, i + wanted.length));
      if (window.every((line, k) => line === target[k])) {
        hits.push(i);
      }
    }
    if (hits.length > 1) {
      return { _tag: "Ambiguous", strategy, lines: hits.slice(0, SHOWN).map((i) => i + 1) };
    }
    const [first] = hits;
    if (first !== undefined) {
      const found = lines.slice(first, first + wanted.length);
      const start = starts[first] ?? 0;
      const last = first + wanted.length - 1;
      const end = (starts[last] ?? 0) + (lines[last]?.length ?? 0);
      return {
        _tag: "Found",
        strategy,
        spans: [{ start, end, replacement: reindent(newBody, wanted, found) }],
      };
    }
  }
  return { _tag: "Missing" };
};

/** The text with every span replaced; spans are in order and do not overlap. */
export const applySpans = (text: string, spans: ReadonlyArray<Span>): string => {
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + span.replacement;
    at = span.end;
  }
  return out + text.slice(at);
};

/**
 * What a missed edit can tell the model: whether the new text is already
 * there, and where the first line of the old text is, when it is somewhere.
 */
export const missHint = (text: string, oldString: string, newString: string): string => {
  if (newString.length > 0 && text.includes(newString)) {
    return "newString is already in the file, so the edit may have been made already";
  }
  const firstLine = oldString
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  if (firstLine === undefined) {
    return "read the file again to see its current content";
  }
  const at: Array<number> = [];
  text.split("\n").forEach((line, i) => {
    if (at.length < SHOWN && line.trim() === firstLine) {
      at.push(i + 1);
    }
  });
  return at.length > 0
    ? `its first line is at line ${at.join(", ")}, but the lines after it differ; read those lines again and copy them exactly`
    : "not even its first line is in the file; read the file again to see its current content";
};

const BOM = "\uFEFF";

/** A file's text with its byte-order mark and CRLF line endings set aside, and how to put them back. */
export interface Normalized {
  readonly text: string;
  /** The model's text in the same convention: CRLF made LF unless the file mixes them. */
  readonly prepare: (text: string) => string;
  readonly restore: (text: string) => string;
}

/**
 * The file as LF text without a byte-order mark. Line endings are converted
 * only when every line ends in CRLF: a file that mixes them is matched as it
 * is, so an edit never rewrites lines it did not touch.
 */
export const normalize = (raw: string): Normalized => {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
  const mixed = !crlf && body.includes("\r\n");
  return {
    text: crlf ? body.replaceAll("\r\n", "\n") : body,
    prepare: (sent) => (mixed ? sent : sent.replaceAll("\r\n", "\n")),
    restore: (edited) => (bom ? BOM : "") + (crlf ? edited.replaceAll("\n", "\r\n") : edited),
  };
};
