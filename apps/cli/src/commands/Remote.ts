import { CommandError, define, type CommandInput } from "@magentic/plugin";
import { Effect } from "effect";

const run = Effect.fn("rc.run")(function* ({ args, session, ui }: CommandInput) {
  if (session.remoteControl === undefined)
    return yield* new CommandError({
      command: "rc",
      message: "This surface does not support pairing.",
    });
  yield* ui.notify(yield* session.remoteControl(args));
});

export const remoteCommandPlugin = define({
  id: "remote-control-command",
  description: "Pair a browser with the gateway and manage remote access.",
  setup: Effect.fn("remoteCommand.setup")(function* (ctx) {
    yield* ctx.command.register({
      name: "rc",
      description: "Remote control: /rc [status | pair | devices | revoke <id> | on | off]",
      run,
    });
    yield* ctx.command.register({
      name: "remote-control",
      description: "Pair a browser with this gateway",
      run,
    });
  }),
});
