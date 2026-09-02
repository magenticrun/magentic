import { Effect, FileSystem, Path, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { CapabilityAnnotation } from "@magentic/plugin";
import { WorkspaceRoot } from "./WorkspaceRoot.ts";

/**
 * Returned to the model as a tool result rather than failing the run, so the
 * agent can react (ask for a different path, report the problem).
 */
export class FileToolError extends Schema.TaggedError<FileToolError>()("FileToolError", {
  reason: Schema.Literals(["OutsideWorkspace", "NotFound", "IoError"]),
  path: Schema.String,
  message: Schema.String,
}) {}

const PathParam = Schema.String.annotate({
  description: "Path relative to the workspace root, e.g. src/index.ts",
});

export const ReadFile = Tool.make("read_file", {
  description: "Read a UTF-8 text file from the workspace.",
  parameters: Schema.Struct({ path: PathParam }),
  success: Schema.Struct({ path: Schema.String, content: Schema.String }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "fs:read");

export const WriteFile = Tool.make("write_file", {
  description:
    "Write a UTF-8 text file in the workspace, creating parent directories and replacing any existing content.",
  parameters: Schema.Struct({
    path: PathParam,
    content: Schema.String.annotate({ description: "The full new file content" }),
  }),
  success: Schema.Struct({ path: Schema.String, bytes: Schema.Number }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "fs:write");

export const FileTools = Toolkit.make(ReadFile, WriteFile);

/** Handlers for the file tools. Needs a FileSystem, a Path, and a WorkspaceRoot. */
export const fileToolHandlers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* WorkspaceRoot;

  /** Resolve a user path against the root and refuse anything that escapes it. */
  const resolveInside = Effect.fn("FileTools.resolveInside")(function* (requested: string) {
    const absolute = path.resolve(root, requested);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new FileToolError({
        reason: "OutsideWorkspace",
        path: requested,
        message: `${requested} is outside the workspace`,
      });
    }
    return { absolute, relative };
  });

  const ioError = (requested: string) => (error: { readonly message: string }) =>
    new FileToolError({ reason: "IoError", path: requested, message: error.message });

  return FileTools.of({
    read_file: Effect.fn("FileTools.read_file")(function* ({ path: requested }) {
      const { absolute, relative } = yield* resolveInside(requested);
      const exists = yield* fs.exists(absolute).pipe(Effect.mapError(ioError(requested)));
      if (!exists) {
        return yield* new FileToolError({
          reason: "NotFound",
          path: requested,
          message: `${requested} does not exist`,
        });
      }
      const content = yield* fs.readFileString(absolute).pipe(Effect.mapError(ioError(requested)));
      return { path: relative, content };
    }),

    write_file: Effect.fn("FileTools.write_file")(function* ({ path: requested, content }) {
      const { absolute, relative } = yield* resolveInside(requested);
      yield* fs
        .makeDirectory(path.dirname(absolute), { recursive: true })
        .pipe(Effect.mapError(ioError(requested)));
      yield* fs.writeFileString(absolute, content).pipe(Effect.mapError(ioError(requested)));
      return { path: relative, bytes: new TextEncoder().encode(content).byteLength };
    }),
  });
});

export const FileToolsLayer = FileTools.toLayer(fileToolHandlers);
