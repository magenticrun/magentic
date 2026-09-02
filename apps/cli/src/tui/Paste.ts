import type { Attachment } from "@magentic/protocol";
import { createHostClipboard, type HostClipboardService, SyntaxStyle } from "@opentui/core";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Palette } from "./Theme.ts";

/**
 * A paste this long, or with this many lines, is folded into a placeholder in
 * the composer and unfolded again when the message is sent; the thresholds
 * are opencode's.
 */
const FOLD_CHARS = 150;
const FOLD_LINES = 3;

/** What a fold stands for: text to unfold on send, or a file to send along. */
export type Folded =
  | { readonly kind: "text"; readonly placeholder: string; readonly text: string }
  | { readonly kind: "file"; readonly placeholder: string; readonly attachment: Attachment };

/** Windows terminals paste CR-only line breaks; the composer wants LF. */
export const normalise = (text: string): string => text.replace(/\r\n?/g, "\n");

export const shouldFold = (text: string): boolean =>
  text.length > FOLD_CHARS || text.split("\n").length >= FOLD_LINES;

export const textPlaceholder = (index: number, text: string): string =>
  `[Pasted text #${index} +${text.split("\n").length} lines]`;

export const imagePlaceholder = (index: number): string => `[Image #${index}]`;

/** The text with every placeholder still present replaced by what it stands for. */
export const unfold = (text: string, folds: ReadonlyArray<Folded>): string =>
  folds.reduce(
    (result, fold) =>
      fold.kind === "text" ? result.replaceAll(fold.placeholder, fold.text) : result,
    text,
  );

/** The files whose placeholders are still in the text, in the order they appear. */
export const attached = (text: string, folds: ReadonlyArray<Folded>): ReadonlyArray<Attachment> =>
  folds
    .flatMap((fold) => (fold.kind === "file" ? [{ at: text.indexOf(fold.placeholder), fold }] : []))
    .filter(({ at }) => at >= 0)
    .toSorted((a, b) => a.at - b.at)
    .map(({ fold }) => fold.attachment);

/** What the host clipboard holds right now, images before text. */
export type Clipboard =
  | { readonly kind: "image"; readonly mediaType: string; readonly bytes: Uint8Array }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

let host: HostClipboardService | undefined;

/** Read the host clipboard through OpenTUI's native backend; anything it cannot read is empty. */
export const readClipboard = async (): Promise<Clipboard> => {
  host ??= createHostClipboard();
  const result = await host.read({ preferredTypes: [...IMAGE_TYPES, "text/plain"] });
  if (result.status !== "read") {
    return { kind: "empty" };
  }
  const { mimeType, bytes } = result.representation;
  if (mimeType.startsWith("image/")) {
    return { kind: "image", mediaType: mimeType, bytes };
  }
  const text = new TextDecoder().decode(bytes);
  return text.length === 0 ? { kind: "empty" } : { kind: "text", text };
};

/** Put text on the host clipboard; false when the host could not take it. */
export const writeClipboard = async (text: string): Promise<boolean> => {
  host ??= createHostClipboard();
  const result = await host.writeText(text);
  return result.status === "written";
};

export const toAttachment = (mediaType: string, data: Uint8Array, fileName?: string): Attachment =>
  fileName === undefined ? { mediaType, data } : { mediaType, data, fileName };

const IMAGE_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * Dropping a file on most terminals pastes its path, quoted or with spaces
 * escaped. When that path is an image on disk, this is the file; otherwise none.
 */
export const imageAtPath = async (pasted: string): Promise<Attachment | undefined> => {
  const line = pasted.trim();
  if (line.length === 0 || line.includes("\n")) {
    return undefined;
  }
  const path = /^(['"]).*\1$/.test(line) ? line.slice(1, -1) : line.replaceAll("\\ ", " ");
  const mediaType = IMAGE_EXTENSIONS.get(extname(path).toLowerCase());
  if (mediaType === undefined) {
    return undefined;
  }
  try {
    return toAttachment(mediaType, await readFile(path), basename(path));
  } catch {
    return undefined;
  }
};

/** The name the composer's extmarks style placeholders with. */
export const FOLD_STYLE = "fold";

const styles = new Map<Palette, SyntaxStyle>();

/** The composer's syntax style: only the fold placeholders are coloured. One per palette. */
export const composerStyleFor = (colours: Palette): SyntaxStyle => {
  const known = styles.get(colours);
  if (known !== undefined) {
    return known;
  }
  const built = SyntaxStyle.fromStyles({ [FOLD_STYLE]: { fg: colours.accent } });
  styles.set(colours, built);
  return built;
};
