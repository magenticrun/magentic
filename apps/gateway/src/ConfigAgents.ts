import { AgentDefinition, define } from "@magentic/plugin";
import { Effect, FileSystem, Path, Predicate, Queue, Result, Schema, Stream } from "effect";

/** An inline prompt, or a file relative to the configuration directory. */
const PromptSource = Schema.Union([Schema.String, Schema.Struct({ file: Schema.String })]);

/** One `agents/<name>.yaml`. */
const AgentFile = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  prompt: PromptSource,
  tools: Schema.optional(Schema.Array(Schema.String)),
});

export interface ConfigAgentsOptions {
  /** The configuration directory holding `agents/`. */
  readonly dir: string;
  /** Rebuild when files under `agents/` change. SIGHUP rebuilds either way. */
  readonly watch: boolean;
}

const isAgentFile = (name: string) => name.endsWith(".yaml") || name.endsWith(".yml");

const messageOf = (error: { readonly message: string } | string) =>
  Predicate.isString(error) ? error : error.message;

/**
 * Agents from `agents/*.yaml` in the configuration directory. A file that
 * does not decode is logged with its path and skipped; the others still load,
 * so one typo never takes every agent down.
 */
export const configAgentsPlugin = (options: ConfigAgentsOptions) =>
  define<FileSystem.FileSystem | Path.Path>({
    id: "config-agents",
    description: "Agents defined in agents/*.yaml in the configuration directory.",
    setup: Effect.fn("configAgentsPlugin.setup")(function* (ctx) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentsDir = path.join(options.dir, "agents");

      const readText = (file: string) =>
        fs.readFileString(file).pipe(Effect.mapError((error) => error.message));

      const readAgent = Effect.fn("configAgents.read")(function* (file: string) {
        const text = yield* readText(file);
        const parsed = yield* Effect.try({
          try: () => Bun.YAML.parse(text),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        });
        const decoded = yield* Schema.decodeUnknownEffect(AgentFile)(parsed).pipe(
          Effect.mapError((error) => error.message),
        );
        const prompt = Predicate.isString(decoded.prompt)
          ? decoded.prompt
          : yield* readText(path.resolve(options.dir, decoded.prompt.file));
        const base = {
          name: decoded.name,
          description: decoded.description ?? "",
          prompt,
          tools: decoded.tools ?? [],
        };
        return new AgentDefinition(
          decoded.model === undefined ? base : { ...base, model: decoded.model },
        );
      });

      /** Every agent that decodes, in file name order. Never fails; problems are logged. */
      const load = Effect.gen(function* () {
        if (!(yield* fs.exists(agentsDir))) {
          return [];
        }
        const names = yield* fs.readDirectory(agentsDir);
        const agents: Array<AgentDefinition> = [];
        for (const name of names.filter(isAgentFile).toSorted()) {
          const outcome = yield* Effect.result(readAgent(path.join(agentsDir, name)));
          if (Result.isFailure(outcome)) {
            yield* Effect.logError(`agents/${name}: ${outcome.failure}`);
            continue;
          }
          agents.push(outcome.success);
        }
        return agents;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError(`cannot read ${agentsDir}: ${messageOf(error)}`).pipe(
            Effect.as<ReadonlyArray<AgentDefinition>>([]),
          ),
        ),
      );

      yield* ctx.agent.transform((draft) =>
        Effect.map(load, (agents) => {
          for (const agent of agents) {
            draft.set(agent);
          }
        }),
      );

      const reload = ctx.agent.rebuild.pipe(Effect.andThen(Effect.logInfo("agents reloaded")));

      // SIGHUP, for people editing over SSH.
      const sighup = Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const handler = () => Queue.offerUnsafe(queue, undefined);
            process.on("SIGHUP", handler);
            return handler;
          }),
          (handler) => Effect.sync(() => process.off("SIGHUP", handler)),
        ),
      );
      yield* sighup.pipe(
        Stream.runForEach(() => reload),
        Effect.forkScoped,
      );

      if (options.watch) {
        yield* fs.watch(agentsDir, { recursive: true }).pipe(
          Stream.debounce("200 millis"),
          Stream.runForEach(() => reload),
          Effect.catch((error) => Effect.logError(`cannot watch ${agentsDir}: ${error.message}`)),
          Effect.forkScoped,
        );
      }
    }),
  });
