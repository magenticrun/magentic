import { Runtime, Schema } from "effect";

/** A failure that was already explained on the terminal. Only the exit code is left. */
export class Reported extends Schema.TaggedError<Reported>()("Reported", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
}
