import { CommandRegistry, dataDir, describeCause, ModelRegistry } from "@magentic/core";
import {
  CommandError,
  type ChatSession,
  type CommandUi,
  type SessionUsage,
} from "@magentic/plugin";
import type { Attachment, Conversation } from "@magentic/protocol";
import { render } from "@opentui/solid";
import {
  Cause,
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
  Stream,
} from "effect";
import { resolveAgent } from "./Agents.ts";
import { ago } from "./commands/Conversations.ts";
import { ensureGateway, type GatewayClient } from "./Gateway.ts";
import { createChatTui } from "./tui/ChatView.tsx";
import { acquireRenderer } from "./tui/Tui.ts";
import { VERSION } from "./Version.ts";

export interface ChatOptions {
  readonly baseUrl: string;
  readonly agent: Option.Option<string>;
  /** Pick up the most recent conversation, of the agent when one is named. */
  readonly continue: boolean;
  /** Pick up this conversation. */
  readonly resume: Option.Option<string>;
}

/** The conversation asked for cannot be picked up, in words for the terminal. */
export class ResumeError extends Schema.TaggedError<ResumeError>()("ResumeError", {
  message: Schema.String,
}) {}

/** `/name the rest` into its name and trimmed arguments. */
const parseCommand = (input: string): { readonly name: string; readonly args: string } => {
  const body = input.slice(1);
  const at = body.search(/\s/);
  return at < 0
    ? { name: body, args: "" }
    : { name: body.slice(0, at), args: body.slice(at).trim() };
};

/** What the person last chose with `/model`, kept under the data directory for the next chat. */
const ChatPreferences = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), model: Schema.optional(Schema.String) }),
);

const preferencesFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* dataDir, "chat.json");
});

/** The remembered model, when the file is there and readable; nothing here is worth failing for. */
const loadLastModel = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* preferencesFile;
  if (!(yield* fs.exists(file))) {
    return Option.none<string>();
  }
  const stored = yield* Schema.decodeEffect(ChatPreferences)(yield* fs.readFileString(file));
  return Option.fromNullishOr(stored.model);
}).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const saveLastModel = Effect.fn("Cli.chat.saveLastModel")(function* (ref: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* preferencesFile;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(ChatPreferences)({ version: 1, model: ref }),
  );
});

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
 * The conversation the flags ask to pick up: the one named, or the newest
 * (of the agent, when one is named). None when nothing was asked, or nothing
 * is there yet to continue.
 */
const startingConversation = Effect.fn("Cli.chat.startingConversation")(function* (
  client: GatewayClient,
  options: ChatOptions,
) {
  if (Option.isSome(options.resume)) {
    const id = options.resume.value;
    return Option.some(
      yield* client
        .getConversation({ id })
        .pipe(Effect.mapError(() => new ResumeError({ message: `no conversation ${id}` }))),
    );
  }
  if (!options.continue) {
    return Option.none<Conversation>();
  }
  const all = yield* client
    .listConversations({
      agent: Option.getOrUndefined(options.agent),
      directory: process.cwd(),
    })
    .pipe(
      Effect.mapError((error) => new ResumeError({ message: describeCause(Cause.fail(error)) })),
    );
  return Option.fromNullishOr(all[0]);
});

/**
 * The full-screen chat. Inputs come from the view through a queue; each one
 * becomes a run whose events are folded back into the transcript, or, when
 * it starts with a slash, a command from the local plugin host. Esc stops
 * the run in flight; ctrl+c twice ends the session.
 */
export const chat = Effect.fn("Cli.chat")(function* (options: ChatOptions) {
  // The terminal reports light or dark within a few milliseconds, or never;
  // drawing before the answer would flash the wrong palette. The gateway and
  // the agent are found while the answer is awaited, not after.
  const renderer = yield* acquireRenderer;
  const themed = yield* Effect.forkChild(Effect.promise(() => renderer.waitForThemeMode(300)));
  const { client } = yield* ensureGateway(options.baseUrl);
  const starting = yield* startingConversation(client, options);
  const agent = yield* resolveAgent(
    client,
    Option.orElse(options.agent, () => Option.map(starting, (c) => c.agent)),
  );
  if (Option.isSome(starting) && starting.value.agent !== agent.name) {
    return yield* new ResumeError({
      message: `conversation ${starting.value.id} is with ${starting.value.agent}, not ${agent.name}`,
    });
  }
  const commands = yield* CommandRegistry;
  const models = yield* ModelRegistry;

  /** What the person sent: the text, and any images pasted into it. */
  interface Input {
    readonly text: string;
    readonly attachments: ReadonlyArray<Attachment>;
  }
  const inputs = yield* Queue.unbounded<Input>();
  const exit = yield* Deferred.make<void>();
  const quit = () => {
    Deferred.doneUnsafe(exit, Effect.void);
  };
  renderer.once("destroy", quit);

  // The run in flight, so Esc can stop it without ending the session.
  let stop: Deferred.Deferred<void> | undefined;

  // What runs use: the model last chosen with /model when this machine can
  // still run it, otherwise what the gateway said the agent runs on.
  const remembered = yield* loadLastModel.pipe(
    Effect.flatMap((ref) =>
      Option.isSome(ref)
        ? models.resolve(ref).pipe(Effect.option, Effect.map(Option.map((r) => r.ref)))
        : Effect.succeed(Option.none<string>()),
    ),
  );
  const initialModel = Option.orElse(remembered, () => Option.fromNullishOr(agent.model));
  const model = yield* Ref.make(initialModel);
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
    onInterrupt: () => {
      if (stop !== undefined) {
        Deferred.doneUnsafe(stop, Effect.void);
      }
    },
    onExit: quit,
  });
  yield* Fiber.join(themed);
  yield* Effect.promise(() => render(tui.view, renderer));

  const setModel = Effect.fn("Cli.chat.setModel")(function* (ref: string) {
    yield* Ref.set(model, Option.some(ref));
    tui.setModel(ref, yield* contextWindow(models, ref));
  });
  if (Option.isSome(initialModel)) {
    yield* setModel(initialModel.value);
  }
  // Commands run without the platform in their context; hand it over for the file write.
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  /** A choice made here is the one the next chat starts on; a resumed conversation's is not. */
  const chooseModel = Effect.fn("Cli.chat.chooseModel")(function* (ref: string) {
    yield* setModel(ref);
    yield* saveLastModel(ref).pipe(
      Effect.provideContext(platform),
      Effect.catchCause((cause) => Effect.sync(() => tui.error(describeCause(cause)))),
    );
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
    );
    const now = yield* DateTime.now;
    tui.note(`Resumed "${info.title}" · ${info.messages} messages · ${ago(info.updatedAt, now)}`);
  });

  if (Option.isSome(starting)) {
    yield* restore(starting.value).pipe(
      Effect.catchCause((cause) => Effect.sync(() => tui.error(describeCause(cause)))),
    );
  } else if (options.continue) {
    tui.note("No conversation to continue; this is a new one.");
  }

  const runOnce = Effect.fn("Cli.chat.runOnce")(function* ({ text, attachments }: Input) {
    const conversationId = Option.getOrUndefined(yield* Ref.get(conversation));
    const chosen = Option.getOrUndefined(yield* Ref.get(model));
    const outcome = yield* client
      .run({
        agent: agent.name,
        input: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        conversationId,
        model: chosen,
        directory: process.cwd(),
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event._tag === "RunStarted") {
              yield* Ref.set(conversation, Option.some(event.conversationId));
            }
            if (event._tag === "Compacted") {
              // What the model holds is the summary now; the next call says how much that is.
              yield* Ref.set(usage, Option.none());
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
      yield* Ref.set(usage, Option.none());
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
      const interrupt = yield* Deferred.make<void>();
      stop = interrupt;
      tui.addUser(input.text);
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
