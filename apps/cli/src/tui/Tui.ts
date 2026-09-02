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
        useMouse: false,
      }),
    ),
    (renderer) => Effect.sync(() => renderer.destroy()),
  );
