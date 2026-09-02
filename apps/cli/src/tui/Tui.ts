import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Effect, type Scope } from "effect";

/**
 * A full-screen renderer owned by the Effect scope. Effect is the only thing
 * that shuts it down: no signal handlers, no Ctrl+C exit, no console capture,
 * so interruption and finalisers behave like everywhere else in the CLI.
 */
export const acquireRenderer: Effect.Effect<CliRenderer, never, Scope.Scope> =
  Effect.acquireRelease(
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
    (renderer) => Effect.sync(() => renderer.destroy()),
  );
