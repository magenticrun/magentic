import { define } from "@magentic/plugin";
import { Effect, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { shellToolHandlers, ShellTools } from "./ShellTool.ts";
import { ToolOutputDir } from "./ToolOutput.ts";
import type { WorkspaceRoot } from "./WorkspaceRoot.ts";

/** The shell tool, its own plugin so a team can disable it without losing the file tools. */
export const shellToolPlugin = define<
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | WorkspaceRoot
>({
  id: "shell",
  description: "Run shell commands inside the workspace.",
  setup: Effect.fn("shellToolPlugin.setup")(function* (ctx) {
    // Full outputs go under the data directory, where they are nobody's project files.
    const handlers = yield* ShellTools.toHandlers(
      shellToolHandlers.pipe(Effect.provideService(ToolOutputDir, `${ctx.paths.data}/tool-output`)),
    );
    const toolkit = yield* ShellTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
  }),
});
