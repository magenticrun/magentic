import type { RunEvent } from "@magentic/protocol";
import { Console, Effect, type Option, type Schema, Stream, Terminal } from "effect";
import { resolveAgent } from "./Agents.ts";
import { ensureGateway } from "./Gateway.ts";

export interface RunOptions {
  readonly baseUrl: string;
  readonly agent: Option.Option<string>;
  readonly input: string;
}

const summarise = (value: Schema.Json): string => JSON.stringify(value);

/** One input, events printed as plain lines. For pipes, scripts, and CI. */
export const run = Effect.fn("Cli.run")(function* (options: RunOptions) {
  const { client } = yield* ensureGateway(options.baseUrl);
  const agent = yield* resolveAgent(client, options.agent);
  const terminal = yield* Terminal.Terminal;

  const print = (event: RunEvent) => {
    switch (event._tag) {
      case "RunStarted":
      case "ReasoningDelta":
      case "TokenUsage":
        return Effect.void;
      case "TextDelta":
        return terminal.display(event.text).pipe(Effect.orDie);
      case "ToolCall":
        return Console.log(`\n→ ${event.name} ${summarise(event.params)}`);
      case "ToolResult":
        return Console.log(
          `← ${event.name} ${event.isFailure ? "failed" : "ok"} ${summarise(event.result)}`,
        );
      case "RunFinished":
        return Console.log("");
      case "RunFailed":
        return Console.error(`\nrun failed: ${event.message}`);
    }
  };

  const events = yield* client.agents.run({
    params: { name: agent.name },
    payload: { input: options.input, directory: process.cwd() },
  });
  yield* Stream.runForEach(events, print);
}, Effect.scoped);
