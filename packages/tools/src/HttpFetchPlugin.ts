import { define } from "@magentic/plugin";
import { Effect, type FileSystem, type Path } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { httpFetchHandlers, HttpFetchTools } from "./HttpFetch.ts";
import { ToolOutputDir } from "./ToolOutput.ts";

/**
 * The fetch tool on its own plugin, so a team can disable network egress
 * without losing the file tools or the shell. The output directory is the
 * host's: long pages spill there beside long command output.
 */
export const httpFetchPlugin = define<
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | ToolOutputDir
>({
  id: "http-fetch",
  description: "Fetch pages over HTTPS and read them as text.",
  setup: Effect.fn("httpFetchPlugin.setup")(function* (ctx) {
    const outputDir = yield* ToolOutputDir;
    const handlers = yield* HttpFetchTools.toHandlers(
      httpFetchHandlers.pipe(Effect.provideService(ToolOutputDir, outputDir)),
    );
    const toolkit = yield* HttpFetchTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
  }),
});
