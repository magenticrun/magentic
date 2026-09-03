import { ModelRegistry } from "@magentic/core";
import { apiKeysFile, Codex, modelPlugins } from "@magentic/model";
import type { ModelProviderRegistration } from "@magentic/plugin";
import { Config, Effect, Option, Path, Result, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { runLogin } from "./auth/Login.ts";
import { LocalHost } from "./Host.ts";
import * as Prompt from "./auth/Prompt.ts";
import { promptUi } from "./auth/PromptUi.ts";
import { Reported } from "./Reported.ts";

const providerIds = modelPlugins.map((p) => p.id).join(", ");

const providerFlag = Flag.string("provider").pipe(
  Flag.withAlias("p"),
  Flag.withDescription(`Provider id to log in to, skips the picker: ${providerIds}`),
  Flag.optional,
);

const methodFlag = Flag.string("method").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("Login method id, skips the method picker: chatgpt, import or api-key"),
  Flag.optional,
);

interface Credential {
  readonly provider: ModelProviderRegistration;
  readonly summary: string;
}

/** Every provider that currently holds a credential, in picker order. */
const credentials = Effect.fn("Auth.credentials")(function* () {
  const registry = yield* ModelRegistry;
  const found: Array<Credential> = [];
  for (const provider of yield* registry.list) {
    const status = yield* provider.status;
    if (Option.isSome(status)) {
      found.push({ provider, summary: status.value });
    }
  }
  return found;
});

const tilde = (home: string, file: string) =>
  file.startsWith(home) ? `~${file.slice(home.length)}` : file;

/** The directories the credential files live in, for the `list` header. */
const credentialDirs = Effect.fn("Auth.credentialDirs")(function* () {
  const path = yield* Path.Path;
  const home = yield* Config.string("HOME");
  const files = [yield* Codex.codexAuthFile, yield* apiKeysFile];
  const dirs = new Set(files.map((file) => tilde(home, path.dirname(file))));
  return [...dirs].join(", ");
});

const login = Command.make(
  "login",
  { provider: providerFlag, method: methodFlag },
  Effect.fn(function* ({ provider, method }) {
    yield* Prompt.intro("Add credential");
    const ui = yield* promptUi;
    const providers = yield* (yield* ModelRegistry).list;
    const outcome = yield* Effect.result(runLogin({ ui, providers, provider, method }));
    if (Result.isSuccess(outcome)) {
      return;
    }
    const error = outcome.failure;
    if (error._tag === "LoginCancelled") {
      return yield* Prompt.cancel("Cancelled");
    }
    if (error._tag === "NoSuchProvider") {
      yield* Prompt.log.error(error.message);
      yield* Prompt.outro("Done");
    }
    // Anything else was shown by the sign-in flow before it failed.
    return yield* new Reported({ message: error.message });
  }),
).pipe(Command.withDescription("Log in to a provider"));

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* Prompt.intro(`Credentials ${Prompt.dim(yield* credentialDirs())}`);
    const found = yield* credentials();
    for (const { provider, summary } of found) {
      yield* Prompt.log.info(`${provider.name} ${Prompt.dim(summary)}`);
    }
    yield* Prompt.outro(`${found.length} credential${found.length === 1 ? "" : "s"}`);
  }),
).pipe(Command.withAlias("ls"), Command.withDescription("List providers and credentials"));

const providerArgument = Argument.string("provider").pipe(
  Argument.withDescription("Provider id or name to log out from"),
  Argument.optional,
);

const matches = (wanted: string) => (credential: Credential) =>
  credential.provider.id === wanted ||
  credential.provider.name.toLowerCase() === wanted.toLowerCase();

const logout = Command.make(
  "logout",
  { provider: providerArgument },
  Effect.fn(function* ({ provider: wanted }) {
    yield* Prompt.intro("Remove credential");
    const found = yield* credentials();
    if (found.length === 0) {
      yield* Prompt.log.error("No credentials found");
      return yield* Prompt.outro("Done");
    }
    if (Option.isSome(wanted)) {
      const match = found.find(matches(wanted.value));
      if (match === undefined) {
        yield* Prompt.log.error(`Unknown configured provider "${wanted.value}"`);
        yield* Prompt.outro("Done");
        return yield* new Reported({ message: `unknown configured provider ${wanted.value}` });
      }
      yield* match.provider.logout;
      return yield* Prompt.outro("Logout successful");
    }
    const picked = yield* Prompt.select({
      message: "Select provider",
      options: found.map(({ provider, summary }) => ({
        value: provider.id,
        label: provider.name,
        hint: summary,
      })),
    });
    if (Option.isNone(picked)) {
      return yield* Prompt.cancel("Cancelled");
    }
    // SAFETY: the select only offers the ids in `found`.
    const match = found.find((c) => c.provider.id === picked.value) as Credential;
    yield* match.provider.logout;
    yield* Prompt.outro("Logout successful");
  }),
).pipe(Command.withDescription("Log out from a configured provider"));

export const auth = Command.make("auth").pipe(
  Command.withDescription("Manage AI providers and credentials"),
  Command.withSubcommands([login, list, logout]),
  Command.provide(LocalHost),
);
