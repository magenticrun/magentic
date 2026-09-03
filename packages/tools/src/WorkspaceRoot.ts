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

/** Whether a `path.relative` result leaves the directory it is relative to. */
const escapes = (relative: string, path: Path.Path): boolean =>
  relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

/**
 * Links a path may go through before it is given up on, as the kernel does;
 * a loop of dangling links would otherwise never end.
 */
const LINK_HOPS = 40;

/**
 * Where `requested` lands under `root`, or none when it escapes. Lexical
 * first, then the real path of the deepest ancestor that exists, so a link
 * inside the workspace that points outside it is refused and a link that
 * points back inside is allowed. A target that does not exist yet is
 * judged by its nearest existing parent; a link to one is judged by where
 * it points, since writing through it creates the file there.
 */
export const resolveWithin = Effect.fn("WorkspaceRoot.resolveWithin")(function* (
  root: string,
  requested: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  const resolved: Resolved = { absolute, relative };
  const realRoot = yield* fs.realPath(root);
  let candidate = absolute;
  for (let hops = 0; hops <= LINK_HOPS; hops++) {
    if (escapes(path.relative(root, candidate), path)) {
      return Option.none<Resolved>();
    }
    // Walk up until something exists; realPath refuses a path that is not there yet.
    let probe = candidate;
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
    const rest = path.relative(probe, candidate);
    if (rest !== "") {
      // The first thing that does not exist may be a link with nothing at its
      // end yet, which realPath refuses; it is followed by hand.
      const [first = "", ...remaining] = rest.split(path.sep);
      const link = yield* fs.readLink(path.join(probe, first)).pipe(Effect.option);
      if (Option.isSome(link)) {
        candidate = path.join(path.resolve(probe, link.value), ...remaining);
        continue;
      }
    }
    const realTarget = rest === "" ? real.value : path.join(real.value, rest);
    if (escapes(path.relative(realRoot, realTarget), path)) {
      return Option.none<Resolved>();
    }
    return Option.some(resolved);
  }
  return Option.none<Resolved>();
});
