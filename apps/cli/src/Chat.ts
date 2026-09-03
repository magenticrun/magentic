import { CommandRegistry, dataDir, describeCause, ModelRegistry } from "@magentic/core";
import {
  CommandError,
  type ChatSession,
  type CommandUi,
  type SessionUsage,
} from "@magentic/plugin";
import type { Attachment, Conversation, RunEvent } from "@magentic/protocol";
import { render } from "@opentui/solid";
import {
  type Cause,
  Config,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Message } from "./Attachments.ts";
import { ago } from "./commands/Conversations.ts";
import { ensureGateway } from "./Gateway.ts";
import { pickUp, type PickUpOptions } from "./Resume.ts";
import { createChatTui } from "./tui/ChatView.tsx";
import { acquireRenderer } from "./tui/Tui.ts";
import { VERSION } from "./Version.ts";

export interface ChatOptions extends PickUpOptions {
  readonly baseUrl: string;
  /** Sent as soon as the chat is up, as pi sends the messages on its command line. */
  readonly initial: Option.Option<Message>;
}

/** `/name the rest` into its name and trimmed arguments. */
const parseCommand = (input: string): { readonly name: string; readonly args: string } => {
  const body = input.slice(1);
  const at = body.search(/\s/);
  return at < 0
    ? { name: body, args: "" }
    : { name: body.slice(0, at), args: body.slice(at).trim() };
};

/**
 * What the person last chose, kept under the data directory for the next
 * chat: the model, and the thinking level for each model it was set on.
 */
const ChatPreferences = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    model: Schema.optional(Schema.String),
    reasoning: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
type ChatPreferences = typeof ChatPreferences.Type;

const preferencesFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* dataDir, "chat.json");
});

/** What was remembered, when the file is there and readable; nothing here is worth failing for. */
const loadPreferences = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* preferencesFile;
  if (!(yield* fs.exists(file))) {
    return { version: 1 } satisfies ChatPreferences;
  }
  return yield* Schema.decodeEffect(ChatPreferences)(yield* fs.readFileString(file));
}).pipe(Effect.orElseSucceed((): ChatPreferences => ({ version: 1 })));

const savePreferences = Effect.fn("Cli.chat.savePreferences")(function* (
  preferences: ChatPreferences,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* preferencesFile;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, yield* Schema.encodeEffect(ChatPreferences)(preferences));
});

/**
 * What the catalog says of a model, when the providers on this machine know
 * it: how many tokens it can hold (0 when its entry gives no limit) and the
 * thinking levels it can be set to (none when it cannot).
 */
const modelFacts = Effect.fn("Cli.chat.modelFacts")(function* (
  models: ModelRegistry["Service"],
  ref: string,
) {
  const none: ReadonlyArray<string> = [];
  const unknown = { contextWindow: 0, reasoningLevels: none };
  const resolved = yield* models.resolve(Option.some(ref)).pipe(Effect.option);
  if (Option.isNone(resolved)) {
    return unknown;
  }
  const known = yield* resolved.value.provider.models;
  const info = known.find((m) => m.id === resolved.value.model);
  return info === undefined
    ? unknown
    : { contextWindow: info.context, reasoningLevels: info.reasoningLevels };
});

/**
 * The full-screen chat. Inputs come from the view through a queue; each one
 * becomes a run whose events are folded back into the transcript, or, when
 * it starts with a slash, a command from the local plugin host. What is sent
 * during a run is steered into it: the model reads it before its next call.
 * Esc stops the run in flight; ctrl+c twice ends the session. The chat
 * follows its conversation at the gateway, so a run the gateway starts on
 * its own, when a background task ends after the model has answered, shows
 * and takes steering like one the person started.
 */
export const chat = Effect.fn("Cli.chat")(function* (options: ChatOptions) {
  // The terminal reports light or dark within a few milliseconds, or never;
  // drawing before the answer would flash the wrong palette. The gateway and
  // the agent are found while the answer is awaited, not after.
  const renderer = yield* acquireRenderer;
  const themed = yield* Effect.forkChild(Effect.promise(() => renderer.waitForThemeMode(300)));
  const { client } = yield* ensureGateway(options.baseUrl);
  const { agent, starting } = yield* pickUp(client, options);
  const commands = yield* CommandRegistry;
  const models = yield* ModelRegistry;

  /** What the person sent: the text, and any images pasted into it; or a key the loop acts on. */
  interface Input {
    readonly text: string;
    readonly attachments: ReadonlyArray<Attachment>;
    /** ctrl+t: the next thinking level, not a message. */
  }
  const inputs = yield* Queue.unbounded<Input>();
  const exit = yield* Deferred.make<void>();
  const quit = () => {
    Deferred.doneUnsafe(exit, Effect.void);
  };
  renderer.once("destroy", quit);

  // The run in flight, so Esc can stop it without ending the session, and
  // so what is sent meanwhile can be steered into it once the gateway has
  // named it.
  interface InFlight {
    readonly stop: Deferred.Deferred<void>;
    readonly named: Deferred.Deferred<string>;
    readonly ended: Deferred.Deferred<void>;
    runId?: string;
  }
  let inFlight: InFlight | undefined;
  /** The run whose queue was last taken back, which the stop that follows is for. */
  let retracted: InFlight | undefined;
  // The follow lives with the chat, not with any one run, so nothing the
  // gateway starts between runs is missed; it is restarted when the
  // conversation or the thinking level changes.
  const scope = yield* Scope.Scope;
  let following: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  /** A run the gateway started, while it is in flight, and the fiber that stops it on Esc. */
  let followedRun: { readonly run: InFlight; readonly stopper: Fiber.Fiber<void> } | undefined;

  // What runs use: the model last chosen with /model when this machine can
  // still run it, otherwise what the gateway said the agent runs on.
  const preferences = yield* loadPreferences;
  const remembered = yield* Option.fromNullishOr(preferences.model).pipe(
    Option.match({
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (ref) =>
        models.resolve(Option.some(ref)).pipe(Effect.option, Effect.map(Option.map((r) => r.ref))),
    }),
  );
  const initialModel = Option.orElse(remembered, () => Option.fromNullishOr(agent.model));
  const model = yield* Ref.make(initialModel);
  // How hard the model thinks, one of its levels; none for its default.
  const reasoning = yield* Ref.make(Option.none<string>());
  const reasoningLevels = yield* Ref.make<ReadonlyArray<string>>([]);
  // The level chosen on each model, so switching back finds it again.
  const chosenLevels = yield* Ref.make<Record<string, string>>(preferences.reasoning ?? {});
  // Folded from the usage events, for /context.
  const usage = yield* Ref.make(Option.none<SessionUsage>());
  // The conversation the next input continues; the gateway names it on the first run.
  const conversation = yield* Ref.make(Option.none<string>());

  // The header shows where the chat runs, with the home directory as `~`.
  const home = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const cwd = process.cwd();
  const directory =
    home.length > 0 && (cwd === home || cwd.startsWith(`${home}/`))
      ? `~${cwd.slice(home.length)}`
      : cwd;

  const tui = createChatTui({
    directory,
    version: VERSION,
    model: initialModel,
    // Filled in below: the catalog is first read for it, and the screen need not wait.
    contextWindow: 0,
    commands: (yield* commands.list).map(({ name, description }) => ({ name, description })),
    onSubmit: (text, attachments) => {
      Queue.offerUnsafe(inputs, { text, attachments });
    },
    // Steered once the gateway has named the run; a run that ends first, or
    // refuses, leaves the message with the view to send after.
    onSteer: (text, attachments) => {
      const run = inFlight;
      if (run === undefined) {
        return Promise.resolve(false);
      }
      const named = Effect.race(
        Effect.asSome(Deferred.await(run.named)),
        Effect.as(Deferred.await(run.ended), Option.none<string>()),
      );
      return runPromise(
        Effect.flatMap(named, (runId) =>
          Option.isNone(runId)
            ? Effect.succeed(false)
            : client
                .steer({
                  runId: runId.value,
                  input: text,
                  attachments: attachments.length > 0 ? attachments : undefined,
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchCause(() => Effect.succeed(false)),
                ),
        ),
      );
    },
    onRetract: () => {
      const run = inFlight;
      if (run === undefined) {
        return Promise.resolve([]);
      }
      retracted = run;
      const runId = run.runId;
      if (runId === undefined) {
        return Promise.resolve([]);
      }
      return runPromise(
        client
          .unsteer({ runId })
          .pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([]))),
      );
    },
    // Now, not in turn behind the run: the queue waits for the run to end.
    onCycleReasoning: () => {
      void runPromise(cycleReasoning);
    },
    // The stop follows a retract; a run that ended in between, letting the
    // queue start the next one, is not the run the person meant to stop.
    onInterrupt: () => {
      const run = inFlight;
      const meant = retracted;
      retracted = undefined;
      if (run !== undefined && (meant === undefined || meant === run)) {
        Deferred.doneUnsafe(run.stop, Effect.void);
      }
    },
    onExit: quit,
  });
  yield* Fiber.join(themed);
  yield* Effect.promise(() => render(tui.view, renderer));

  // Commands run without the platform in their context; hand it over for the file write.
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(platform);
  const persist = Effect.gen(function* () {
    const chosen = yield* Ref.get(model);
    const levels = yield* Ref.get(chosenLevels);
    yield* savePreferences(
      Option.isSome(chosen)
        ? { version: 1, reasoning: levels, model: chosen.value }
        : { version: 1, reasoning: levels },
    );
  }).pipe(
    Effect.provideContext(platform),
    Effect.catchCause((cause) => Effect.sync(() => tui.error(describeCause(cause)))),
  );

  /** The model later runs use, with the thinking level last chosen on it when it still has one. */
  const setModel = Effect.fn("Cli.chat.setModel")(function* (ref: string) {
    yield* Ref.set(model, Option.some(ref));
    const facts = yield* modelFacts(models, ref);
    yield* Ref.set(reasoningLevels, facts.reasoningLevels);
    const level = Option.fromNullishOr((yield* Ref.get(chosenLevels))[ref]).pipe(
      Option.filter((l) => facts.reasoningLevels.includes(l)),
    );
    yield* Ref.set(reasoning, level);
    tui.setModel(ref, facts.contextWindow);
    tui.setReasoning(level);
  });
  if (Option.isSome(initialModel)) {
    yield* setModel(initialModel.value);
  }
  /** A choice made here is the one the next chat starts on; a resumed conversation's is not. */
  const chooseModel = Effect.fn("Cli.chat.chooseModel")(function* (ref: string) {
    yield* setModel(ref);
    yield* persist;
  });

  /** ctrl+t: the next of the model's thinking levels, round to its default after the last, as opencode cycles variants. */
  const cycleReasoning = Effect.gen(function* () {
    const chosen = yield* Ref.get(model);
    const levels = yield* Ref.get(reasoningLevels);
    if (Option.isNone(chosen) || levels.length === 0) {
      tui.flash("this model has no thinking levels");
      return;
    }
    const current = yield* Ref.get(reasoning);
    const at = Option.match(current, { onNone: () => -1, onSome: (l) => levels.indexOf(l) });
    const next = at + 1 < levels.length ? Option.some(levels[at + 1] ?? "") : Option.none<string>();
    yield* Ref.set(reasoning, next);
    yield* Ref.update(chosenLevels, (all) => {
      const { [chosen.value]: _, ...rest } = all;
      return Option.isSome(next) ? { ...rest, [chosen.value]: next.value } : rest;
    });
    tui.setReasoning(next);
    yield* persist;
    // The runs the gateway starts think as hard as the person's do.
    if (following !== undefined) {
      yield* follow(following.id);
    }
  });

  /** Show an earlier conversation and make it the one the next input continues. */
  const restore = Effect.fn("Cli.chat.restore")(function* (info: Conversation) {
    const entries = yield* client.transcript({ id: info.id });
    const latest = Option.fromNullishOr(info.usage);
    yield* Ref.set(conversation, Option.some(info.id));
    yield* Ref.set(usage, latest);
    if (Predicate.isString(info.model)) {
      yield* setModel(info.model);
    }
    tui.restore(
      entries,
      Option.match(latest, {
        onNone: () => 0,
        onSome: (u) => u.latest.inputTokens + u.latest.outputTokens,
      }),
      Option.flatMap(latest, (u) => Option.fromNullishOr(u.totalCost)),
    );
    const now = yield* DateTime.now;
    tui.note(`Resumed "${info.title}" · ${info.messages} messages · ${ago(info.updatedAt, now)}`);
    yield* follow(info.id);
    yield* refreshTasks;
  });

  /** Fold one call's usage into the session's, for /context. */
  const account = (event: RunEvent) =>
    event._tag === "TokenUsage"
      ? Ref.update(usage, (previous) => {
          const before = Option.getOrUndefined(previous);
          const spent = before?.totalCost;
          return Option.some({
            latest: event,
            calls: (before?.calls ?? 0) + 1,
            totalInputTokens: (before?.totalInputTokens ?? 0) + event.inputTokens,
            totalOutputTokens: (before?.totalOutputTokens ?? 0) + event.outputTokens,
            totalCost: event.cost === undefined ? spent : (spent ?? 0) + event.cost,
          });
        })
      : Effect.void;

  const TASK_TOOLS = new Set(["shell", "task_output", "task_stop", "task_list"]);
  /** Whether the event may have changed which background tasks still run. */
  const touchesTasks = (event: RunEvent): boolean =>
    (event._tag === "ToolResult" && TASK_TOOLS.has(event.name)) ||
    event._tag === "Notified" ||
    event._tag === "RunFinished" ||
    event._tag === "RunFailed";

  /** How many of the conversation's background tasks still run, as the gateway says; one that cannot say leaves the count. */
  const refreshTasks = Effect.gen(function* () {
    const id = yield* Ref.get(conversation);
    if (Option.isNone(id)) {
      tui.setTasks(0);
      return;
    }
    const listed = yield* client.listTasks({ conversationId: id.value }).pipe(Effect.option);
    if (Option.isSome(listed)) {
      tui.setTasks(listed.value.filter((task) => task.running).length);
    }
  });

  /** One event, whoever's run it is: counted, drawn, and the task count refreshed when it may have moved. */
  const observe = (event: RunEvent) =>
    Effect.gen(function* () {
      yield* account(event);
      tui.apply(event);
      if (touchesTasks(event)) {
        yield* refreshTasks;
      }
    });

  /** An event of a run the gateway started: in flight like the person's own, steered and stopped the same way. */
  const onFollowed = (event: RunEvent) =>
    Effect.gen(function* () {
      if (event._tag === "RunStarted") {
        const run: InFlight = {
          stop: yield* Deferred.make<void>(),
          named: yield* Deferred.make<string>(),
          ended: yield* Deferred.make<void>(),
          runId: event.runId,
        };
        yield* Deferred.succeed(run.named, event.runId);
        // Esc asks the gateway to stop a run it started; the follow then hears the end.
        const stopper = yield* Effect.forkIn(
          Deferred.await(run.stop).pipe(
            Effect.andThen(client.stopRun({ runId: event.runId }).pipe(Effect.ignore)),
          ),
          scope,
        );
        followedRun = { run, stopper };
        inFlight = run;
        tui.setBusy(true);
      }
      yield* observe(event);
      if (
        (event._tag === "RunFinished" || event._tag === "RunFailed") &&
        followedRun !== undefined
      ) {
        const { run, stopper } = followedRun;
        followedRun = undefined;
        if (inFlight === run) {
          inFlight = undefined;
        }
        yield* Deferred.succeed(run.ended, undefined);
        yield* Fiber.interrupt(stopper);
        tui.setBusy(false);
      }
    });

  const stopFollowing = Effect.suspend(() => {
    const current = following;
    following = undefined;
    return current === undefined ? Effect.void : Fiber.interrupt(current.fiber);
  });

  /** Follow the conversation at the gateway, in place of whatever was followed before. */
  const follow = Effect.fn("Cli.chat.follow")(function* (conversationId: string) {
    yield* stopFollowing;
    const level = Option.getOrUndefined(yield* Ref.get(reasoning));
    const fiber = yield* Effect.forkIn(
      client.follow({ conversationId, agent: agent.name, reasoning: level }).pipe(
        Stream.runForEach(onFollowed),
        Effect.catchCause((cause) =>
          Effect.sync(() => tui.error(`Not following the conversation: ${describeCause(cause)}`)),
        ),
      ),
      scope,
    );
    following = { id: conversationId, fiber };
  });

  if (Option.isSome(starting)) {
    yield* restore(starting.value).pipe(
      Effect.catchCause((cause) => Effect.sync(() => tui.error(describeCause(cause)))),
    );
  } else if (options.continue) {
    tui.note("No conversation to continue; this is a new one.");
  }
  if (Option.isSome(options.initial) && options.initial.value.text.length > 0) {
    yield* Queue.offer(inputs, options.initial.value);
  }

  const runOnce = Effect.fn("Cli.chat.runOnce")(function* (
    { text, attachments }: Input,
    run: InFlight,
  ) {
    const conversationId = Option.getOrUndefined(yield* Ref.get(conversation));
    const chosen = Option.getOrUndefined(yield* Ref.get(model));
    const level = Option.getOrUndefined(yield* Ref.get(reasoning));
    const outcome = yield* client
      .run({
        agent: agent.name,
        input: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        conversationId,
        model: chosen,
        directory: process.cwd(),
        reasoning: level,
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event._tag === "RunStarted") {
              yield* Ref.set(conversation, Option.some(event.conversationId));
              run.runId = event.runId;
              yield* Deferred.succeed(run.named, event.runId);
              // A first run names the conversation; from here the gateway's own runs in it are heard.
              if (following?.id !== event.conversationId) {
                yield* follow(event.conversationId);
              }
            }
            yield* observe(event);
          }),
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
  const gatewayFailed = (command: string) => (cause: Cause.Cause<unknown>) =>
    new CommandError({ command, message: describeCause(cause) });
  const session: ChatSession = {
    agent: agent.name,
    model: Ref.get(model),
    setModel: chooseModel,
    reasoning: Ref.get(reasoning),
    usage: Ref.get(usage),
    conversation: Effect.gen(function* () {
      const id = yield* Ref.get(conversation);
      if (Option.isNone(id)) {
        return Option.none<Conversation>();
      }
      return yield* client.getConversation({ id: id.value }).pipe(Effect.option);
    }),
    conversations: client
      .listConversations({ agent: agent.name, directory: process.cwd() })
      .pipe(Effect.catchCause((cause) => gatewayFailed("resume")(cause))),
    resume: Effect.fn("Cli.chat.resume")(function* (id: string) {
      const info = yield* client
        .getConversation({ id })
        .pipe(
          Effect.mapError(
            () => new CommandError({ command: "resume", message: `no conversation ${id}` }),
          ),
        );
      if (info.agent !== agent.name) {
        return yield* new CommandError({
          command: "resume",
          message: `conversation ${id} is with ${info.agent}, not ${agent.name}`,
        });
      }
      yield* restore(info).pipe(Effect.catchCause((cause) => gatewayFailed("resume")(cause)));
    }),
    startNew: Effect.gen(function* () {
      yield* stopFollowing;
      yield* Ref.set(conversation, Option.none());
      yield* Ref.set(usage, Option.none());
      tui.reset();
      tui.note("New conversation");
    }),
    compact: Effect.gen(function* () {
      const id = yield* Ref.get(conversation);
      if (Option.isNone(id)) {
        return yield* new CommandError({
          command: "compact",
          message: "Nothing to compact yet; this conversation has not started.",
        });
      }
      const done = yield* client
        .compact({ id: id.value })
        .pipe(Effect.catchCause((cause) => gatewayFailed("compact")(cause)));
      // The totals stand; only the latest call's picture of the context is
      // stale until the next call, which the gateway counted this one into.
      tui.apply(done);
    }),
    rename: Effect.fn("Cli.chat.rename")(function* (title: string) {
      const id = yield* Ref.get(conversation);
      if (Option.isNone(id)) {
        return yield* new CommandError({
          command: "rename",
          message: "Nothing to rename yet; this conversation has not started.",
        });
      }
      const renamed = yield* client
        .rename({ id: id.value, title })
        .pipe(Effect.catchCause((cause) => gatewayFailed("rename")(cause)));
      tui.note(`Renamed to "${renamed.title}"`);
    }),
    mcpServers: client
      .listMcpServers()
      .pipe(Effect.catchCause((cause) => gatewayFailed("mcp")(cause))),
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
      if (input.text.startsWith("/")) {
        yield* runCommand(input.text);
        continue;
      }
      const run: InFlight = {
        stop: yield* Deferred.make<void>(),
        named: yield* Deferred.make<string>(),
        ended: yield* Deferred.make<void>(),
      };
      inFlight = run;
      tui.addUser(input.text);
      tui.setBusy(true);
      const finished = yield* Effect.race(
        Effect.as(runOnce(input, run), true),
        Effect.as(Deferred.await(run.stop), false),
      );
      inFlight = undefined;
      yield* Deferred.succeed(run.ended, undefined);
      if (!finished) {
        tui.interrupted();
      }
      tui.setBusy(false);
    }
  });

  yield* Effect.race(loop, Deferred.await(exit));
}, Effect.scoped);
