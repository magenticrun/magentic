import { dataDir, RelayConfig } from "@magentic/core";
import { Console, Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as Prompt from "./auth/Prompt.ts";

export const relaySetup = Command.make(
  "relay-setup",
  {
    url: Flag.String("url").pipe(Flag.withDefault("https://relay1.magentic.run")),
    publicUrl: Flag.String("public-url").pipe(Flag.optional),
  },
  Effect.fn(function* ({ url, publicUrl }) {
    const token = yield* Prompt.password({
      message: "Gateway credential (mrk_…)",
      validate: (value) =>
        value?.startsWith("mrk_")
          ? undefined
          : "Enter the gateway credential minted by your relay.",
    });
    if (Option.isNone(token)) return;
    const dir = yield* dataDir;
    const fs = yield* FileSystem.FileSystem;
    const config = new RelayConfig({
      url,
      token: token.value,
      publicUrl: Option.getOrElse(publicUrl, () => url),
    });
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    const staging = `${dir}/relay.${crypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(staging, JSON.stringify(config), { mode: 0o600 });
    yield* fs.rename(staging, `${dir}/relay.json`);
    yield* Console.log(
      "Relay saved. Restart any running gateway, then open magentic and use /rc. The connection starts in the background.",
    );
  }),
).pipe(Command.withDescription("Save a relay credential once; magentic connects automatically"));
