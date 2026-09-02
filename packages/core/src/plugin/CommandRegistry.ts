import type { CommandRegistration } from "@magentic/plugin";
import { Context, Effect, Option } from "effect";

/** The slash commands plugins registered, in plugin order. Surfaces run them beside a chat. */
export class CommandRegistry extends Context.Service<
  CommandRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<CommandRegistration>>;
    get(name: string): Effect.Effect<Option.Option<CommandRegistration>>;
  }
>()("magentic/core/CommandRegistry") {}

/** Builds the registry over the host's command registrations. */
export const commandRegistryOver = (
  commands: Effect.Effect<ReadonlyArray<CommandRegistration>>,
): CommandRegistry["Service"] =>
  CommandRegistry.of({
    list: commands,
    get: (name) =>
      Effect.map(commands, (all) => Option.fromNullishOr(all.find((c) => c.name === name))),
  });
