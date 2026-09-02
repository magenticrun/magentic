import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

/** Absolute directory that file tools may touch. Nothing outside it is reachable. */
export class WorkspaceRoot extends Context.Service<WorkspaceRoot, string>()(
  "magentic/tools/WorkspaceRoot",
) {
  static readonly layer = (root: string) => Layer.succeed(WorkspaceRoot, root);
}

export interface Resolved {
  /** The lexical absolute path the caller may open. */
  readonly absolute: string;
  /** Workspace-relative, `""` for the root itself. */
  readonly relative: string;
}

/**
 * Where `requested` lands under `root`, or none when it escapes. Lexical
 * first, then the real path of the deepest ancestor that exists, so a link
 * inside the workspace that points outside it is refused and a link that
 * points back inside is allowed. A target that does not exist yet is
 * judged by its nearest existing parent.
 */
export const resolveWithin = Effect.fn("WorkspaceRoot.resolveWithin")(function* (
  root: string,
  requested: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return Option.none<Resolved>();
  }
  const realRoot = yield* fs.realPath(root);
  // Walk up until something exists; realPath refuses a path that is not there yet.
  let probe = absolute;
  let real = Option.none<string>();
  while (Option.isNone(real)) {
    real = yield* fs.realPath(probe).pipe(Effect.option);
    if (Option.isSome(real)) {
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      return Option.none<Resolved>();
    }
    probe = parent;
  }
  const rest = path.relative(probe, absolute);
  const realTarget = rest === "" ? real.value : path.join(real.value, rest);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    return Option.none<Resolved>();
  }
  const resolved: Resolved = { absolute, relative };
  return Option.some(resolved);
});
