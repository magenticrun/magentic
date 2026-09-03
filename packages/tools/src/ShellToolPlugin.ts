import { define } from "@magentic/plugin";
import { Effect, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { BackgroundTasks } from "./BackgroundTasks.ts";
import { shellToolHandlers, ShellTools } from "./ShellTool.ts";
import { ToolOutputDir } from "./ToolOutput.ts";
import type { WorkspaceRoot } from "./WorkspaceRoot.ts";

/**
 * The shell tool with the background task tools beside it, its own plugin
 * so a team can disable it without losing the file tools. The background
 * tasks and the output directory are the host's: the gateway keeps the
 * tasks in its own scope, so they run on after the calls that started them,
 * die when the gateway stops, and can be listed for a surface as well as
 * for the model.
 */
export const shellToolPlugin = define<
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | WorkspaceRoot
  | ToolOutputDir
  | BackgroundTasks
>({
  id: "shell",
  description: "Run shell commands inside the workspace, in the foreground or the background.",
  setup: Effect.fn("shellToolPlugin.setup")(function* (ctx) {
    const outputDir = yield* ToolOutputDir;
    const tasks = yield* BackgroundTasks;
    const handlers = yield* ShellTools.toHandlers(
      shellToolHandlers.pipe(
        Effect.provideService(ToolOutputDir, outputDir),
        Effect.provideService(BackgroundTasks, tasks),
      ),
    );
    const toolkit = yield* ShellTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
  }),
});
