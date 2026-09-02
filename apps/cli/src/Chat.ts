import { CommandRegistry, ModelRegistry } from "@magentic/core";
import type { ChatSession, CommandUi, SessionUsage } from "@magentic/plugin";
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

/** `/name the rest` into its name and trimmed arguments. */
const parseCommand = (input: string): { readonly name: string; readonly args: string } => {
  const body = input.slice(1);
  const at = body.search(/\s/);
  return at < 0
    ? { name: body, args: "" }
    : { name: body.slice(0, at), args: body.slice(at).trim() };
};

/**
 * How many tokens a model can hold, when the providers on this machine know
 * the model and its catalog entry gives a limit; 0 otherwise.
 */
const contextWindow = Effect.fn("Cli.chat.contextWindow")(function* (
  models: ModelRegistry["Service"],
  ref: string,
) {
  const resolved = yield* models.resolve(Option.some(ref)).pipe(Effect.option);
  if (Option.isNone(resolved)) {
    return 0;
  }
  const known = yield* resolved.value.provider.models;
  return known.find((m) => m.id === resolved.value.model)?.context ?? 0;
});

/**
 * The full-screen chat. Inputs come from the view through a queue; each one
 * becomes a run whose events are folded back into the transcript, or, when
 * it starts with a slash, a command from the local plugin host. Esc stops
 * the run in flight; ctrl+c twice ends the session.
 */
export const chat = Effect.fn("Cli.chat")(function* (options: ChatOptions) {
  const { client, embedded } = yield* ensureGateway(options.baseUrl);
  const agent = yield* resolveAgent(client, options.agent);
  const commands = yield* CommandRegistry;
  const models = yield* ModelRegistry;

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

  // What runs use; starts as what the gateway said the agent runs on.
  const model = yield* Ref.make(Option.fromNullishOr(agent.model));
  // Folded from the usage events, for /context.
  const usage = yield* Ref.make(Option.none<SessionUsage>());

  const tui = createChatTui({
    agent: agent.name,
    gateway: embedded ? `${options.baseUrl} (started here)` : options.baseUrl,
    model: Option.fromNullishOr(agent.model),
    contextWindow: Predicate.isString(agent.model) ? yield* contextWindow(models, agent.model) : 0,
    commands: (yield* commands.list).map(({ name, description }) => ({ name, description })),
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
    const chosen = Option.getOrUndefined(yield* Ref.get(model));
    const outcome = yield* client.agents
      .run({ params: { name: agent.name }, payload: { input, conversationId, model: chosen } })
      .pipe(
        Effect.flatMap(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event._tag === "RunStarted") {
                yield* Ref.set(conversation, Option.some(event.conversationId));
              }
              if (event._tag === "TokenUsage") {
                yield* Ref.update(usage, (previous) =>
                  Option.some({
                    latest: event,
                    calls: Option.match(previous, { onNone: () => 1, onSome: (u) => u.calls + 1 }),
                    totalInputTokens:
                      Option.match(previous, {
                        onNone: () => 0,
                        onSome: (u) => u.totalInputTokens,
                      }) + event.inputTokens,
                    totalOutputTokens:
                      Option.match(previous, {
                        onNone: () => 0,
                        onSome: (u) => u.totalOutputTokens,
                      }) + event.outputTokens,
                  }),
                );
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

  const ui: CommandUi = {
    pick: (picker) =>
      Effect.callback((resume) => {
        tui.pick(picker, (picked) => resume(Effect.succeed(picked)));
      }),
    notify: (message) => Effect.sync(() => tui.note(message)),
  };
  const session: ChatSession = {
    agent: agent.name,
    model: Ref.get(model),
    setModel: Effect.fn("Cli.chat.setModel")(function* (ref) {
      yield* Ref.set(model, Option.some(ref));
      tui.setModel(ref, yield* contextWindow(models, ref));
    }),
    usage: Ref.get(usage),
  };

  const runCommand = Effect.fn("Cli.chat.runCommand")(function* (input: string) {
    const { name, args } = parseCommand(input);
    const command = yield* commands.get(name);
    if (Option.isNone(command)) {
      const known = (yield* commands.list).map((c) => `/${c.name}`).join(", ");
      tui.error(
        known.length === 0
          ? `Unknown command /${name}`
          : `Unknown command /${name}; commands: ${known}`,
      );
      return;
    }
    const outcome = yield* Effect.exit(command.value.run({ ui, session, args }));
    tui.dismiss();
    if (outcome._tag === "Failure") {
      tui.error(describeCause(outcome.cause));
    }
  });

  const loop = Effect.gen(function* () {
    while (true) {
      const input = yield* Queue.take(inputs);
      if (input.startsWith("/")) {
        yield* runCommand(input);
        continue;
      }
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

  yield* Effect.race(loop, Deferred.await(exit));
}, Effect.scoped);
