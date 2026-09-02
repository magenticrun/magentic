import { Effect, Option, Redacted, Ref } from "effect";
import { type Choice, LoginCancelled, type LoginUi, Screen } from "@magentic/plugin";
import * as Prompt from "./Prompt.ts";

const orCancelled = <A>(value: Option.Option<A>): Effect.Effect<A, LoginCancelled> =>
  Option.match(value, {
    onNone: () => Effect.fail(new LoginCancelled()),
    onSome: Effect.succeed,
  });

/**
 * The sign-in surface built from clack prompts: a select per picker, a
 * masked input for keys, and one spinner that runs while the controller is
 * busy. Everything prints inline, the way `opencode auth login` does.
 */
export const promptUi: Effect.Effect<LoginUi> = Effect.gen(function* () {
  const active = yield* Ref.make(Option.none<Prompt.Spinner>());

  const busy = Effect.fn("PromptUi.busy")(function* (message: string) {
    const current = yield* Ref.get(active);
    if (Option.isSome(current)) {
      return yield* current.value.message(message);
    }
    const spinner = yield* Prompt.spinner;
    yield* spinner.start(message);
    yield* Ref.set(active, Option.some(spinner));
  });

  /** Ends the spinner if one is running, otherwise logs the message plainly. */
  const settle = Effect.fn("PromptUi.settle")(function* (
    onSpinner: (spinner: Prompt.Spinner) => Effect.Effect<void>,
    otherwise: Effect.Effect<void>,
  ) {
    const current = yield* Ref.getAndSet(active, Option.none());
    yield* Option.match(current, { onNone: () => otherwise, onSome: onSpinner });
  });

  const choose = Effect.fn("PromptUi.choose")(function* (
    title: string,
    choices: ReadonlyArray<Choice>,
  ) {
    const picked = yield* Prompt.select({
      message: title,
      options: choices.map((choice) => ({
        value: choice.id,
        label: choice.name,
        hint: choice.description,
      })),
    });
    const id = yield* orCancelled(picked);
    // SAFETY: the select only offers the ids of `choices`.
    return choices.find((choice) => choice.id === id) as Choice;
  });

  const secret = Effect.fn("PromptUi.secret")(function* (title: string, placeholder: string) {
    const entered = yield* Prompt.password({
      message: title,
      validate: (value) => (value !== undefined && value.length > 0 ? undefined : placeholder),
    });
    const value = yield* orCancelled(entered);
    return Redacted.make(value.trim());
  });

  const show = (screen: Screen) =>
    Screen.$match(screen, {
      Busy: ({ message }) => busy(message),
      DeviceCode: ({ url, code }) =>
        Effect.andThen(
          settle((spinner) => spinner.stop(`Go to: ${url}`), Prompt.log.info(`Go to: ${url}`)),
          Effect.andThen(
            Prompt.log.info(`Enter code: ${code}`),
            busy("Waiting for authorization..."),
          ),
        ),
      Done: ({ message }) =>
        Effect.andThen(
          settle((spinner) => spinner.stop(message), Prompt.log.success(message)),
          Prompt.outro("Done"),
        ),
      Failed: ({ message }) =>
        Effect.andThen(
          settle((spinner) => spinner.error(message), Prompt.log.error(message)),
          Prompt.outro("Done"),
        ),
    });

  const ui: LoginUi = { choose, secret, show, finish: show };
  return ui;
});
