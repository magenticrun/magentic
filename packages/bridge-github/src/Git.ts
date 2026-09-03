import { Effect, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  /** The command line, with the credential left out. */
  command: Schema.String,
  message: Schema.String,
}) {}

/** The longest a git command may run before it is killed; a clone of a large repository is not one. */
const TIMEOUT = "5 minutes";

/**
 * Runs `git` in one directory. A token, when a command needs one, goes in
 * the child's environment as an extra HTTP header for this one process,
 * never in the arguments where `ps` would show it and never in the shell
 * tool's environment where the model would.
 */
export interface Git {
  run(args: ReadonlyArray<string>): Effect.Effect<string, GitError>;
  /** As `run`, authenticated to GitHub with the installation token for the command's life. */
  runWithToken(
    args: ReadonlyArray<string>,
    token: Redacted.Redacted<string>,
  ): Effect.Effect<string, GitError>;
}

/** `host` is where the repositories live: `github.com`, or the Enterprise host; the token is sent there only. */
export const gitIn = Effect.fn("Git.in")(function* (cwd: string, host: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const execute = Effect.fn("Git.run")(function* (
    args: ReadonlyArray<string>,
    env: Record<string, string>,
  ) {
    const command = `git ${args.join(" ")}`;
    const failed = (message: string) => new GitError({ command, message });
    return yield* Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make("git", args, {
            cwd,
            env: {
              ...env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              GIT_PAGER: "cat",
              NO_COLOR: "1",
            },
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        .pipe(Effect.mapError((error) => failed(error.message)));
      const text = (stream: Stream.Stream<Uint8Array, { readonly message: string }>) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError((error) => failed(error.message)),
        );
      const [stdout, stderr, exit] = yield* Effect.all(
        [
          text(handle.stdout),
          text(handle.stderr),
          handle.exitCode.pipe(Effect.mapError((error) => failed(error.message))),
        ],
        { concurrency: 3 },
      );
      if (Number(exit) !== 0) {
        return yield* failed(`exit ${Number(exit)}: ${stderr.trim() || stdout.trim()}`);
      }
      return stdout.trim();
    }).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => failed(`took longer than ${TIMEOUT}`),
      }),
      Effect.scoped,
    );
  });

  const git: Git = {
    run: (args) => execute(args, {}),
    runWithToken: (args, token) => {
      // The header git sends for github.com; `GIT_CONFIG_*` is how one process gets one config entry.
      const basic = Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64");
      return execute(args, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      });
    },
  };
  return git;
});
