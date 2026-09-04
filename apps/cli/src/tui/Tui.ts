import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Effect, type Scope } from "effect";

/** A renderer and the effect that puts the terminal back, whoever gets there first. */
export interface Screen {
  readonly renderer: CliRenderer;
  /**
   * Give the terminal back now. The scope calls it too, so it is safe to call
   * twice; the second time does nothing.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * A full-screen renderer owned by the Effect scope. Effect is the only thing
 * that shuts it down: no signal handlers, no Ctrl+C exit, no console capture,
 * so interruption and finalisers behave like everywhere else in the CLI.
 *
 * The scope releases it last, because it is acquired first, and by then the
 * gateway embedded in this process has been torn down. That teardown can take
 * seconds, and the screen it happens behind is frozen: the keyboard belongs to
 * the renderer, and the terminal is in raw mode, so ctrl+c is a byte nobody
 * reads any more. So the chat closes the screen itself as soon as the session
 * ends, and the release below is only the path for a failure on the way up.
 */
export const acquireScreen: Effect.Effect<Screen, never, Scope.Scope> = Effect.gen(function* () {
  let closed = false;
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
        exitSignals: [],
        consoleMode: "disabled",
        // The wheel scrolls the transcript; without tracking, the terminal keeps the wheel.
        useMouse: true,
        // A click would otherwise focus the nearest focusable renderable it
        // landed on, and the transcript scrollbox is one, so clicking it (or
        // clicking into the window from elsewhere, which terminals forward)
        // took the keyboard away from the composer. The view decides what
        // is focused.
        autoFocus: false,
      }),
    ),
    (started) =>
      Effect.sync(() => {
        if (!closed) {
          closed = true;
          started.destroy();
        }
      }),
  );
  const close = Effect.sync(() => {
    if (!closed) {
      closed = true;
      renderer.destroy();
    }
  });
  return { renderer, close };
});
