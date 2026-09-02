import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { auth } from "./Auth.ts";
import { chat } from "./Chat.ts";
import { ensureGateway, gatewayClient } from "./Gateway.ts";
import { LocalHost } from "./Host.ts";
import { run } from "./Run.ts";

const gateway = Flag.string("gateway").pipe(
  Flag.withAlias("g"),
  Flag.withDescription("Base URL of the gateway; started here when nothing answers locally"),
  Flag.withDefault("http://localhost:4321"),
);

const agentFlag = Flag.string("agent").pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Agent to talk to; the first one the gateway hosts by default"),
  Flag.optional,
);

const continueFlag = Flag.boolean("continue").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Continue the most recent conversation, of the agent when one is named"),
  Flag.withDefault(false),
);

const resumeFlag = Flag.string("resume").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Continue the conversation with this id; /resume in the chat lists them"),
  Flag.optional,
);

const agentArgument = Argument.string("agent").pipe(
  Argument.withDescription("Agent to talk to; the first one the gateway hosts by default"),
  Argument.optional,
);

/** `magentic` on its own opens the chat. */
const magentic = Command.make("magentic", {
  agent: agentArgument,
  continue: continueFlag,
  resume: resumeFlag,
}).pipe(
  Command.withSharedFlags({ gateway }),
  Command.withHandler(({ agent, continue: latest, resume, gateway: baseUrl }) =>
    chat({ baseUrl, agent, continue: latest, resume }).pipe(Effect.provide(LocalHost)),
  ),
  Command.withDescription("Chat with an agent in the terminal"),
);

const agents = Command.make(
  "agents",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const client = yield* gatewayClient(root.gateway);
    const list = yield* client.agents.list();
    if (list.length === 0) {
      return yield* Console.log("no agents registered");
    }
    for (const agent of list) {
      yield* Console.log(`${agent.name}\t${agent.description}`);
    }
  }),
).pipe(Command.withDescription("List agents hosted by the gateway"));

const runCommand = Command.make(
  "run",
  { agent: agentFlag, input: Argument.string("input") },
  Effect.fn(function* ({ agent, input }) {
    const root = yield* magentic;
    yield* run({ baseUrl: root.gateway, agent, input });
  }),
).pipe(Command.withDescription("Send one input and print the events as plain text"));

const pluginList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const { client } = yield* ensureGateway(root.gateway);
    const plugins = yield* client.plugins.list();
    for (const plugin of plugins) {
      const contributed = [
        ...plugin.tools.map((t) => `tool ${t}`),
        ...plugin.providers.map((p) => `provider ${p}`),
        ...plugin.agents.map((a) => `agent ${a}`),
        ...plugin.commands.map((c) => `command /${c}`),
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

magentic.pipe(
  Command.withSubcommands([agents, runCommand, plugin, auth]),
  Command.run({ version: "0.0.0" }),
  Effect.provide([BunServices.layer, FetchHttpClient.layer]),
  BunRuntime.runMain,
);
