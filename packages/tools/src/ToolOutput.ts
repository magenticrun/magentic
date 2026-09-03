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
  readonly omitted: number;
}

const HALF = Math.floor(OUTPUT_LIMIT / 2);
export const EMPTY: Bounded = { head: "", tail: "", omitted: 0 };

/** Whether the buffer is still one unbroken prefix, short of the limit. */
export const whole = (buffer: Bounded): boolean => buffer.omitted === 0 && buffer.tail === "";

/** Appends a chunk, keeping at most `HALF` characters at each end. */
export const push = (buffer: Bounded, chunk: string): Bounded => {
  if (whole(buffer) && buffer.head.length + chunk.length <= OUTPUT_LIMIT) {
    return { ...buffer, head: buffer.head + chunk };
  }
  // Past the limit: a fixed head, and a tail that slides over everything after it.
  const joined = whole(buffer) ? buffer.head + chunk : buffer.tail + chunk;
  const head = whole(buffer) ? joined.slice(0, HALF) : buffer.head;
  const rest = whole(buffer) ? joined.slice(HALF) : joined;
  const tail = rest.slice(-HALF);
  const omitted = buffer.omitted + (rest.length - tail.length);
  return { head, tail, omitted };
};

/** The text the model sees, with a note where the middle was and where the whole is. */
export const render = (buffer: Bounded, savedAs: string | undefined): Captured =>
  whole(buffer)
    ? { text: buffer.head, truncated: false }
    : {
        text: `${buffer.head}\n… ${buffer.omitted} characters omitted${
          savedAs === undefined ? "" : `; the whole output is in ${savedAs}`
        } …\n${buffer.tail}`,
        truncated: true,
      };

/** The last `limit` characters of what the buffer holds, for a glance rather than a read. */
export const tailOf = (buffer: Bounded, limit: number): string => {
  const text = whole(buffer) ? buffer.head : buffer.tail;
  return text.length > limit ? `…${text.slice(-limit)}` : text;
};
