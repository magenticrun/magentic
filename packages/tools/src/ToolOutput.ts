import { Context, Layer } from "effect";

/**
 * Where tools keep output too long to hand the model whole, such as a
 * command's full stdout, so it can read the part it wants. Under the data
 * directory, not the workspace: nothing here is the project's.
 */
export class ToolOutputDir extends Context.Service<ToolOutputDir, string>()(
  "magentic/tools/ToolOutputDir",
) {
  static readonly layer = (dir: string) => Layer.succeed(ToolOutputDir, dir);
}
