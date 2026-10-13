import { Context, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect";

/**
 * What the harness adds to every agent's own prompt at the start of a run,
 * given when the conversation began. Empty unless the gateway provides it,
 * so a runner in a test sees the agent's prompt alone.
 */
export const SystemContext = Context.Reference<(startedAt: DateTime.Utc) => Effect.Effect<string>>(
  "magentic/core/SystemContext",
  { defaultValue: () => () => Effect.succeed("") },
);

/** Instruction files looked for in each directory, the first one found winning. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Characters of one instruction file the prompt takes at most, as Hermes caps them. */
export const INSTRUCTION_MAX_CHARS = 20_000;

/**
 * The workspace as the model needs to know it, and the instructions the
 * project leaves for agents, as opencode, pi, and Hermes all give them.
 *
 * Instructions come from an `AGENTS.md`, or a `CLAUDE.md` when there is
 * none, in the workspace root and each directory above it up to the root of
 * its git repository, outermost first so the nearest reads last and wins.
 * Outside a repository only the root's own is read: a home directory's file
 * is not the project's. The files are read on every run, so an edit counts
 * from the next one, and the text only changes when they do, which keeps
 * the provider's prompt cache warm.
 *
 * The date is the day the conversation began rather than today, for the
 * same reason: a prompt that changed at midnight would be read again in full.
 */
export const layerWorkspace = (root: string) =>
  Layer.effect(
    SystemContext,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

      /** The directories whose instructions count, outermost first, and whether a repository holds them. */
      const chain = Effect.gen(function* () {
        const dirs: Array<string> = [];
        for (let dir = root; ;) {
          dirs.push(dir);
          if (yield* exists(path.join(dir, ".git"))) {
            return { dirs: dirs.toReversed(), git: true };
          }
          const parent = path.dirname(dir);
          if (parent === dir) {
            return { dirs: [root], git: false };
          }
          dir = parent;
        }
      });

      /** The first instruction file of a directory, cut to size, or none. */
      const instructionsIn = Effect.fnUntraced(function* (dir: string) {
        for (const name of INSTRUCTION_FILES) {
          const file = path.join(dir, name);
          const text = yield* fs.readFileString(file).pipe(Effect.option);
          if (Option.isSome(text) && text.value.trim() !== "") {
            const body =
              text.value.length > INSTRUCTION_MAX_CHARS
                ? `${text.value.slice(0, INSTRUCTION_MAX_CHARS)}\n[cut at ${INSTRUCTION_MAX_CHARS} of ${text.value.length} characters; read the file for the rest]`
                : text.value.trimEnd();
            const shown = path.relative(root, file);
            return Option.some(
              `<instructions path="${shown.startsWith("..") ? file : shown}">\n${body}\n</instructions>`,
            );
          }
        }
        return Option.none<string>();
      });

      return (startedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const { dirs, git } = yield* chain;
          const found = yield* Effect.forEach(dirs, instructionsIn);
          const files = found.filter(Option.isSome).map((file) => file.value);
          const environment = [
            "<environment>",
            `Workspace root: ${root}`,
            `Git repository: ${git ? "yes" : "no"}`,
            `Platform: ${process.platform}`,
            `Conversation started: ${DateTime.formatIsoDateUtc(startedAt)} (UTC)`,
            "</environment>",
          ].join("\n");
          if (files.length === 0) {
            return environment;
          }
          return [
            environment,
            "The project's instructions for agents follow, from its AGENTS.md or CLAUDE.md files. " +
              "Follow them; where two disagree, the later file, nearer the workspace, wins.",
            ...files,
          ].join("\n\n");
        });
    }),
  );
