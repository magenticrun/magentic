import type { Attachment } from "@magentic/protocol";
import { Effect, FileSystem, Path, Schema } from "effect";

export const toAttachment = (mediaType: string, data: Uint8Array, fileName?: string): Attachment =>
  fileName === undefined ? { mediaType, data } : { mediaType, data, fileName };

/** The image types the providers take; anything else at an `@path` goes along as text. */
export const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** An `@path` argument names a file that cannot be read. */
class FileUnreadable extends Schema.TaggedError<FileUnreadable>()("FileUnreadable", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** What the arguments add up to: the words as one message, with the files named by `@path` along. */
export interface Message {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/**
 * The positional arguments as one message, as pi reads them: `@path` puts
 * the file in the message (images as attachments, anything else as a block
 * of text under its path) and everything else is the words, in order,
 * joined by spaces.
 */
export const composeMessage = Effect.fn("Cli.composeMessage")(function* (
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const words: Array<string> = [];
  const blocks: Array<string> = [];
  const attachments: Array<Attachment> = [];
  for (const arg of args) {
    if (!arg.startsWith("@") || arg.length === 1) {
      words.push(arg);
      continue;
    }
    const file = arg.slice(1);
    const bytes = yield* fs
      .readFile(file)
      .pipe(Effect.mapError((error) => new FileUnreadable({ path: file, message: error.message })));
    const mediaType = IMAGE_EXTENSIONS.get(path.extname(file).toLowerCase());
    if (mediaType === undefined) {
      blocks.push(`${file}:\n\`\`\`\n${new TextDecoder().decode(bytes)}\n\`\`\``);
    } else {
      attachments.push(toAttachment(mediaType, bytes, path.basename(file)));
    }
  }
  const text = [words.join(" "), ...blocks].filter((part) => part.length > 0).join("\n\n");
  return { text, attachments } satisfies Message;
});
