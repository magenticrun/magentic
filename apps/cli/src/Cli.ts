import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { remoteClient, remoteCommand } from "./Remote.ts";
import { relaySetup } from "./RelaySetup.ts";
import { auth } from "./Auth.ts";
import { ensureGateway } from "./Gateway.ts";
import { LocalHost } from "./Host.ts";
import { composeMessage } from "./Attachments.ts";
import { print, type OutputMode } from "./Print.ts";
import { Reported } from "./Reported.ts";
import { VERSION } from "./Version.ts";

const gateway = Flag.String("gateway").pipe(
  Flag.withAlias("g"),
  Flag.withDescription("Base URL of the gateway; started here when nothing answers locally"),
  Flag.withDefault("http://localhost:4321"),
);

const agentFlag = Flag.String("agent").pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Agent to talk to; the first one the gateway hosts by default"),
  Flag.optional,
);

const continueFlag = Flag.Boolean("continue").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Continue the most recent conversation, of the agent when one is named"),
  Flag.withDefault(false),
);

const sessionFlag = Flag.String("session").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Continue the conversation with this id; /resume in the chat lists them"),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("Run on this provider/model instead of the agent's own"),
  Flag.optional,
);

const thinkingFlag = Flag.String("thinking").pipe(
  Flag.withDescription("How hard the model thinks: one of its levels, such as low, medium or high"),
  Flag.optional,
);

const printFlag = Flag.Boolean("print").pipe(
  Flag.withAlias("p"),
  Flag.withDescription(
    "Print the reply and exit instead of opening the chat; what is piped on stdin joins the message",
  ),
  Flag.withDefault(false),
);

const modeFlag = Flag.ChoiceWithValue("mode", [
  ["text", "text"],
  ["json", "json"],
] as const).pipe(
  Flag.withDescription(
    "What --print writes: text puts the reply on stdout and tool activity on stderr; json puts every run event on stdout, one JSON line each, and implies --print",
  ),
  Flag.withDefault<OutputMode>("text"),
);

const messageArgument = Argument.String("message").pipe(
  Argument.withDescription(
    "What to send, with @path for a file to send along; opens the chat with it sent, or with --print, prints the reply",
  ),
  Argument.variadic(),
);

/** The chat draws full screen and reads keys: it needs a terminal on both ends. */
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

/**
 * `magentic` on its own opens the chat, and `magentic <message>` opens it
 * with the message sent. `-p` prints the reply instead and exits, as pi
 * does; so does anything without a terminal on both ends, such as a pipe,
 * a script or a service, where the chat cannot draw.
 */
const magentic = Command.make("magentic", {
  message: messageArgument,
  agent: agentFlag,
  continue: continueFlag,
  session: sessionFlag,
  model: modelFlag,
  thinking: thinkingFlag,
  print: printFlag,
  mode: modeFlag,
}).pipe(
  Command.withSharedFlags({ gateway }),
  Command.withHandler(
    Effect.fn(function* (options) {
      const message = yield* composeMessage(options.message).pipe(
        Effect.catchTag("FileUnreadable", (error) =>
          Console.error(`cannot read ${error.path}: ${error.message}`).pipe(
            Effect.andThen(new Reported({ message: error.message })),
          ),
        ),
      );
      const pickUp = {
        baseUrl: options.gateway,
        agent: options.agent,
        continue: options.continue,
        session: options.session,
      };
      if (options.print || options.mode === "json" || !interactive) {
        return yield* print({
          ...pickUp,
          message,
          model: options.model,
          thinking: options.thinking,
          mode: options.mode,
        });
      }
      // The chat brings the terminal UI with it, which no other command needs.
      const { chat } = yield* Effect.promise(() => import("./Chat.ts"));
      return yield* chat({
        ...pickUp,
        initial:
          message.text.length > 0 || message.attachments.length > 0
            ? Option.some(message)
            : Option.none(),
      }).pipe(Effect.provide(LocalHost));
    }),
  ),
  Command.withDescription("Chat with an agent in the terminal, or with --print, ask once and exit"),
);

/** The gateway for a subcommand, its failure said in a line rather than thrown as a trace. */
const clientFor = Effect.fn("Cli.clientFor")(function* (baseUrl: string) {
  const { client } = yield* ensureGateway(baseUrl).pipe(
    Effect.catchTag("GatewayUnreachable", (error) =>
      Console.error(error.message).pipe(Effect.andThen(new Reported({ message: error.message }))),
    ),
  );
  return client;
});

const agents = Command.make(
  "agents",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const client = yield* clientFor(root.gateway);
    const list = yield* client.listAgents();
    if (list.length === 0) {
      return yield* Console.log("no agents registered");
    }
    for (const agent of list) {
      yield* Console.log(`${agent.name}\t${agent.description}`);
    }
  }, Effect.scoped),
).pipe(Command.withDescription("List agents hosted by the gateway"));

const pluginList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const client = yield* clientFor(root.gateway);
    const plugins = yield* client.listPlugins();
    for (const plugin of plugins) {
      const contributed = [
        ...plugin.tools.map((t) => `tool ${t}`),
        ...plugin.providers.map((p) => `provider ${p}`),
        ...plugin.agents.map((a) => `agent ${a}`),
        ...plugin.commands.map((c) => `command /${c}`),
        ...plugin.bridges.map((b) => `bridge ${b}`),
        ...plugin.routes.map((r) => `route ${r}`),
      ].join(", ");
      const status = plugin.status === "failed" ? `failed: ${plugin.error ?? ""}` : plugin.status;
      yield* Console.log(`${plugin.id}\t${plugin.source}\t${status}\t${contributed}`);
    }
  }, Effect.scoped),
).pipe(Command.withAlias("ls"), Command.withDescription("List plugins and what each contributed"));

const plugin = Command.make("plugin").pipe(
  Command.withDescription("Inspect the plugins the gateway loaded"),
  Command.withSubcommands([pluginList]),
);

const rc = Command.make(
  "rc",
  { action: Argument.String("action").pipe(Argument.optional) },
  Effect.fn(function* ({ action }) {
    const root = yield* magentic;
    yield* ensureGateway(root.gateway);
    const client = yield* remoteClient(root.gateway);
    yield* Console.log(
      yield* remoteCommand(
        client,
        Option.getOrElse(action, () => ""),
        Effect.succeed(Option.none()),
      ).pipe(
        Effect.catchTag("CommandError", (error) =>
          Console.error(error.message).pipe(
            Effect.andThen(new Reported({ message: error.message })),
          ),
        ),
      ),
    );
  }, Effect.scoped),
).pipe(Command.withDescription("Pair a browser or check remote-control status"));

const gatewayStop = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const client = yield* remoteClient(root.gateway);
    yield* client.stopGateway();
    yield* Console.log("Gateway stopping. Remote access and background tasks stop with it.");
  }, Effect.scoped),
);
const gatewayCommands = Command.make("gateway").pipe(Command.withSubcommands([gatewayStop]));

magentic.pipe(
  Command.withSubcommands([agents, plugin, auth, rc, relaySetup, gatewayCommands]),
  Command.run({ version: VERSION }),
  Effect.provide([BunServices.layer, FetchHttpClient.layer]),
  BunRuntime.runMain,
);
