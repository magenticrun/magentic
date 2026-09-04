import type { Attachment } from "@magentic/protocol";
import { Effect, Option } from "effect";

/**
 * Images on their way to a model, brought down to what the model will
 * actually look at.
 *
 * A screenshot pasted into the composer is whatever the display made it:
 * three thousand pixels across and several megabytes of PNG. No provider
 * sees it that way — each scales the image down before its vision encoder
 * reads a pixel, and bills for the pixels it kept — and several refuse a
 * file past five megabytes outright. So the long edge is brought to
 * `MAX_IMAGE_EDGE` once, here, where the attachments of every surface pass:
 * the model is shown the same picture, the run costs less, and a paste from
 * a retina display cannot fail a call on its size alone.
 *
 * Anything this cannot read, or cannot make smaller, goes along untouched.
 * Shrinking is an optimisation, never a condition of sending.
 */

/** The longest edge a model is given; past this every provider scales the image itself. */
export const MAX_IMAGE_EDGE = 1568;

/**
 * Bytes past which an image is re-encoded even when its dimensions are
 * within bounds — a lossless screenshot can be that large at any size.
 */
export const MAX_IMAGE_BYTES = 4 * 1_048_576;

/**
 * The types Bun can both read and write, each with how it is written back.
 * GIF, BMP and TIFF decode but have no encoder, so an attachment in one of
 * them is passed along as it came rather than turned into something else.
 */
const ENCODERS = new Map<string, (image: Bun.Image) => Bun.Image>([
  ["image/png", (image) => image.png()],
  ["image/jpeg", (image) => image.jpeg({ quality: 85 })],
  ["image/webp", (image) => image.webp({ quality: 85 })],
]);

/** One attachment, no larger than the bounds; the original whenever that cannot be had. */
const fit = Effect.fnUntraced(function* (file: Attachment) {
  const encoder = Option.fromNullishOr(ENCODERS.get(file.mediaType));
  if (Option.isNone(encoder)) {
    return file;
  }
  const meta = yield* Effect.tryPromise(() => new Bun.Image(file.data).metadata()).pipe(
    Effect.option,
  );
  // A file that does not decode is not ours to fix: the provider says so, in
  // its own words, rather than this dropping it or guessing at a format.
  if (Option.isNone(meta)) {
    return file;
  }
  const { width, height } = meta.value;
  const edge = Math.max(width, height);
  if (edge <= MAX_IMAGE_EDGE && file.data.length <= MAX_IMAGE_BYTES) {
    return file;
  }
  // Scaling the width by the ratio the long edge needs keeps the aspect
  // ratio, whichever edge that is; height follows from it.
  const target = Math.max(1, Math.round(width * Math.min(1, MAX_IMAGE_EDGE / edge)));
  const smaller = yield* Effect.tryPromise(() =>
    encoder.value(new Bun.Image(file.data).resize(target)).bytes(),
  ).pipe(Effect.option);
  if (Option.isNone(smaller) || smaller.value.length >= file.data.length) {
    return file;
  }
  return { ...file, data: smaller.value };
});

/**
 * The attachments as the model should get them. Called where they reach a
 * prompt rather than where they arrive, so a file is measured once no matter
 * which surface sent it.
 */
export const fitAttachments = Effect.fn("Attachments.fit")(function* (
  files: ReadonlyArray<Attachment>,
) {
  if (files.length === 0) {
    return files;
  }
  return yield* Effect.forEach(files, fit);
});
