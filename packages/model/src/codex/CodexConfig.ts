import { Config } from "effect";

/** Where the gateway and the CLI keep the ChatGPT tokens. Never inside the config directory. */
export const codexAuthFile = Config.String("MAGENTIC_CODEX_AUTH_FILE").pipe(
  Config.orElse(() =>
    Config.map(Config.String("HOME"), (home) => `${home}/.config/magentic/codex-auth.json`),
  ),
);

/** The Codex CLI's own login file, for a one-time import. */
export const codexCliAuthFile = Config.String("CODEX_HOME").pipe(
  Config.orElse(() => Config.map(Config.String("HOME"), (home) => `${home}/.codex`)),
  Config.map((codexHome) => `${codexHome}/auth.json`),
);
