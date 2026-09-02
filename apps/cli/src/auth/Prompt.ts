import * as prompts from "@clack/prompts";
import { Effect, Option } from "effect";

/**
 * `@clack/prompts` wrapped in Effect. Cancelling a prompt (esc or ctrl+c)
 * yields `Option.none` instead of clack's cancel symbol.
 */

export const intro = (message: string) => Effect.sync(() => prompts.intro(message));
export const outro = (message: string) => Effect.sync(() => prompts.outro(message));
export const cancel = (message: string) => Effect.sync(() => prompts.cancel(message));

export const log = {
  info: (message: string) => Effect.sync(() => prompts.log.info(message)),
  warn: (message: string) => Effect.sync(() => prompts.log.warn(message)),
  error: (message: string) => Effect.sync(() => prompts.log.error(message)),
  success: (message: string) => Effect.sync(() => prompts.log.success(message)),
};

/** Grey text for secondary detail on the same line as a label. */
export const dim = (text: string) => `\x1b[90m${text}\x1b[0m`;

const optional = <A>(result: A | symbol): Option.Option<A> =>
  prompts.isCancel(result) ? Option.none() : Option.some(result);

export const select = <Value>(options: prompts.SelectOptions<Value>) =>
  Effect.map(
    Effect.promise(() => prompts.select(options)),
    (result) => optional(result),
  );

export const text = (options: prompts.TextOptions) =>
  Effect.map(
    Effect.promise(() => prompts.text(options)),
    (result) => optional(result),
  );

export const password = (options: prompts.PasswordOptions) =>
  Effect.map(
    Effect.promise(() => prompts.password(options)),
    (result) => optional(result),
  );

export interface Spinner {
  start(message: string): Effect.Effect<void>;
  /** Replace the message while the spinner keeps going. */
  message(message: string): Effect.Effect<void>;
  stop(message: string): Effect.Effect<void>;
  error(message: string): Effect.Effect<void>;
}

export const spinner: Effect.Effect<Spinner> = Effect.sync(() => {
  const s = prompts.spinner();
  return {
    start: (message) => Effect.sync(() => s.start(message)),
    message: (message) => Effect.sync(() => s.message(message)),
    stop: (message) => Effect.sync(() => s.stop(message)),
    error: (message) => Effect.sync(() => s.error(message)),
  };
});
