import { Context, Layer } from "effect";

/** Absolute directory that file tools may touch. Nothing outside it is reachable. */
export class WorkspaceRoot extends Context.Service<WorkspaceRoot, string>()(
  "magentic/tools/WorkspaceRoot",
) {
  static readonly layer = (root: string) => Layer.succeed(WorkspaceRoot, root);
}
