import { define } from "@magentic/plugin";
import { Effect, type FileSystem, type Path } from "effect";
import { fileToolHandlers, FileTools } from "./FileTools.ts";
import type { WorkspaceRoot } from "./WorkspaceRoot.ts";

/** `read_file` and `write_file`, confined to the WorkspaceRoot the host provides. */
export const fileToolsPlugin = define<FileSystem.FileSystem | Path.Path | WorkspaceRoot>({
  id: "file-tools",
  description: "Read and write text files inside the workspace.",
  setup: Effect.fn("fileToolsPlugin.setup")(function* (ctx) {
    const handlers = yield* FileTools.toHandlers(fileToolHandlers);
    const toolkit = yield* FileTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
  }),
});
