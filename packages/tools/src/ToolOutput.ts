import { Context, Layer } from "effect";

/**
 * Where tools keep output too long to hand the model whole, such as a
 * command's full stdout, so it can read the part it wants. Under the data
 * directory, not the workspace: nothing here is the project's.
 */
export class ToolOutputDir extends Context.Service<ToolOutputDir, string>()(
  "magentic/tools/ToolOutputDir",
) {
  static readonly layer = (dir: string) => Layer.succeed(ToolOutputDir, dir);
}

/** Characters of stdout or stderr the model gets back; the middle goes when there is more. */
export const OUTPUT_LIMIT = 30_000;

export interface Captured {
  readonly text: string;
  readonly truncated: boolean;
}

/** Output kept while it streams: the first half, the last half, and how much fell between. */
export interface Bounded {
  readonly head: string;
  readonly tail: string;
  /** Characters dropped from the middle. */
  readonly omitted: number;
  /** Line breaks among them, so the note can count lines rather than characters. */
  readonly omittedLines: number;
}

const HALF = Math.floor(OUTPUT_LIMIT / 2);
/**
 * How far a cut may move to land on a line break. Further than this the
 * output has few breaks, minified JSON or a progress bar, and cutting in the
 * line loses less than moving to one.
 */
const SNAP = Math.floor(HALF / 4);
export const EMPTY: Bounded = { head: "", tail: "", omitted: 0, omittedLines: 0 };

/** Whether the buffer is still one unbroken prefix, short of the limit. */
export const whole = (buffer: Bounded): boolean => buffer.omitted === 0 && buffer.tail === "";

const isHighSurrogate = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc_00 && code <= 0xdf_ff;

/** The first `n` code units, one fewer when the last would be the first half of a surrogate pair. */
const prefix = (text: string, n: number): string =>
  n > 0 && n < text.length && isHighSurrogate(text.charCodeAt(n - 1))
    ? text.slice(0, n - 1)
    : text.slice(0, n);

/** The last `n` code units, one fewer when the first would be the second half of a surrogate pair. */
const suffix = (text: string, n: number): string => {
  if (n <= 0) {
    return "";
  }
  if (n >= text.length) {
    return text;
  }
  const start = text.length - n;
  return isLowSurrogate(text.charCodeAt(start)) ? text.slice(start + 1) : text.slice(start);
};

const lineBreaks = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    count += 1;
  }
  return count;
};

/* oxlint-disable no-control-regex -- escape sequences are made of control characters. */
/**
 * Terminal escape sequences: colour and cursor codes (CSI), titles and
 * hyperlinks (OSC), and the two-character ones. A command writes them
 * despite NO_COLOR more often than not, and to the model they are noise.
 */
const ESCAPES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/g;
/** An escape sequence the cut left unfinished at the end of the head. */
const UNFINISHED_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$/;
/* oxlint-enable no-control-regex */

/** Text as the model reads it; the saved files keep the escapes, since they are the output as written. */
const plain = (text: string): string => text.replace(ESCAPES, "");

/** Appends a chunk, keeping at most `HALF` characters at each end. */
export const push = (buffer: Bounded, chunk: string): Bounded => {
  if (whole(buffer) && buffer.head.length + chunk.length <= OUTPUT_LIMIT) {
    return { ...buffer, head: buffer.head + chunk };
  }
  // Past the limit: a fixed head, and a tail that slides over everything after it.
  // Neither cut splits a character outside the basic plane in two.
  const joined = whole(buffer) ? buffer.head + chunk : buffer.tail + chunk;
  const head = whole(buffer) ? prefix(joined, HALF) : buffer.head;
  const rest = whole(buffer) ? joined.slice(head.length) : joined;
  const tail = suffix(rest, HALF);
  const dropped = rest.slice(0, rest.length - tail.length);
  return {
    head,
    tail,
    omitted: buffer.omitted + dropped.length,
    omittedLines: buffer.omittedLines + lineBreaks(dropped),
  };
};

/**
 * The text the model sees, with a note where the middle was and where the
 * whole is. The cuts move to line breaks when one is near, so the model
 * reads whole lines on both sides and the note can say how many lines went.
 */
export const render = (buffer: Bounded, savedAs: string | undefined): Captured => {
  if (whole(buffer)) {
    return { text: plain(buffer.head), truncated: false };
  }
  const end = buffer.head.lastIndexOf("\n");
  const headSnapped = end !== -1 && end >= buffer.head.length - SNAP;
  const head = headSnapped ? buffer.head.slice(0, end + 1) : buffer.head;
  const start = buffer.tail.indexOf("\n");
  const tailSnapped = start !== -1 && start < SNAP;
  const tail = tailSnapped ? buffer.tail.slice(start + 1) : buffer.tail;
  const moved =
    buffer.head.slice(head.length) + buffer.tail.slice(0, buffer.tail.length - tail.length);
  const characters = buffer.omitted + moved.length;
  const lines = buffer.omittedLines + lineBreaks(moved);
  // Only when both cuts are on a break is the middle whole lines, and the count exact.
  const amount =
    headSnapped && tailSnapped && lines > 0
      ? `${lines} ${lines === 1 ? "line" : "lines"} (${characters} characters)`
      : `${characters} characters`;
  const note = `… ${amount} omitted${
    savedAs === undefined ? "" : `; the whole output is in ${savedAs}`
  } …`;
  const shownHead = plain(head).replace(UNFINISHED_ESCAPE, "");
  return {
    text: `${shownHead}${shownHead.endsWith("\n") ? "" : "\n"}${note}\n${plain(tail)}`,
    truncated: true,
  };
};

/** The last `limit` characters of what the buffer holds, for a glance rather than a read. */
export const tailOf = (buffer: Bounded, limit: number): string => {
  const text = plain(whole(buffer) ? buffer.head : buffer.tail);
  return text.length > limit ? `…${suffix(text, limit)}` : text;
};
