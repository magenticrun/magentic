import { render } from "@opentui/solid";
import { Cause, Deferred, Effect, Option, Predicate, Queue, Ref, Stream } from "effect";
import { resolveAgent } from "./Agents.ts";
import { ensureGateway } from "./Gateway.ts";
import { createChatTui } from "./tui/ChatView.tsx";
import { acquireRenderer } from "./tui/Tui.ts";

export interface ChatOptions {
  readonly baseUrl: string;
  readonly agent: Option.Option<string>;
}

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }
  return String(error);
};

/**
 * The full-screen chat. Inputs come from the view through a queue; each one
 * becomes a run whose events are folded back into the transcript. Esc stops
 * the run in flight; ctrl+c twice ends the session.
 */
export const chat = Effect.fn("Cli.chat")(function* (options: ChatOptions) {
  const { client, embedded } = yield* ensureGateway(options.baseUrl);
  const agent = yield* resolveAgent(client, options.agent);

  const renderer = yield* acquireRenderer;
  // The terminal reports light or dark within a few milliseconds; drawing
  // before the answer would flash the wrong palette.
  yield* Effect.promise(() => renderer.waitForThemeMode(300));
  const inputs = yield* Queue.unbounded<string>();
  const exit = yield* Deferred.make<void>();
  const quit = () => {
    Deferred.doneUnsafe(exit, Effect.void);
  };
  renderer.once("destroy", quit);

  // The run in flight, so Esc can stop it without ending the session.
  let stop: Deferred.Deferred<void> | undefined;

  const tui = createChatTui({
    agent: agent.name,
    gateway: embedded ? `${options.baseUrl} (started here)` : options.baseUrl,
    model: Option.fromNullishOr(agent.model),
    onSubmit: (text) => {
      Queue.offerUnsafe(inputs, text);
    },
    onInterrupt: () => {
      if (stop !== undefined) {
        Deferred.doneUnsafe(stop, Effect.void);
      }
    },
    onExit: quit,
  });
  yield* Effect.promise(() => render(tui.view, renderer));

  const conversation = yield* Ref.make(Option.none<string>());

  const runOnce = Effect.fn("Cli.chat.runOnce")(function* (input: string) {
    const conversationId = Option.getOrUndefined(yield* Ref.get(conversation));
    const outcome = yield* client.agents
      .run({ params: { name: agent.name }, payload: { input, conversationId } })
      .pipe(
        Effect.flatMap(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event._tag === "RunStarted") {
                yield* Ref.set(conversation, Option.some(event.conversationId));
              }
              tui.apply(event);
            }),
          ),
        ),
        Effect.exit,
      );
    if (outcome._tag === "Failure") {
      tui.apply({ _tag: "RunFailed", message: describeCause(outcome.cause) });
    }
  });

  const session = Effect.gen(function* () {
    while (true) {
      const input = yield* Queue.take(inputs);
      const interrupt = yield* Deferred.make<void>();
      stop = interrupt;
      tui.addUser(input);
      tui.setBusy(true);
      const finished = yield* Effect.race(
        Effect.as(runOnce(input), true),
        Effect.as(Deferred.await(interrupt), false),
      );
      stop = undefined;
      if (!finished) {
        tui.interrupted();
      }
      tui.setBusy(false);
    }
  });

  yield* Effect.race(session, Deferred.await(exit));
}, Effect.scoped);
