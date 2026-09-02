import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { CapabilityAnnotation } from "@magentic/plugin";
import { WorkspaceRoot } from "./WorkspaceRoot.ts";

/**
 * Returned to the model as a tool result rather than failing the run, so the
 * agent can react (ask for a different path, report the problem).
 */
export class FileToolError extends Schema.TaggedError<FileToolError>()("FileToolError", {
  reason: Schema.Literals([
    "OutsideWorkspace",
    "NotFound",
    "NotADirectory",
    "InvalidPattern",
    "NoMatch",
    "Ambiguous",
    "NoChange",
    "IoError",
  ]),
  path: Schema.String,
  message: Schema.String,
}) {}

/** Entries a listing shows at most; the model can list a subdirectory for more. */
export const LIST_LIMIT = 500;
/** Files a glob returns at most. */
export const GLOB_LIMIT = 200;
/** Matching lines a search returns at most. */
export const GREP_LIMIT = 100;
/** Files a search reads at most. */
const GREP_FILE_LIMIT = 10_000;
/** Directories a walk enters at most, so a symlink cycle ends. */
const WALK_DIR_LIMIT = 5_000;
/** A matching line is cut here so one minified file cannot fill the result. */
const LINE_MAX_CHARS = 250;

/** Directories a walk never enters: nobody wants matches from these, and they are huge. */
const PRUNED = new Set(["node_modules", ".git"]);
const pruned = (name: string): boolean => PRUNED.has(name) || name.startsWith(".");

const PathParam = Schema.String.annotate({
  description: "Path relative to the workspace root, e.g. src/index.ts",
});

const DirectoryParam = Schema.optional(
  Schema.String.annotate({
    description: "Directory relative to the workspace root; the root itself when omitted",
  }),
);

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

export const EditFile = Tool.make("edit_file", {
  description:
    "Replace an exact string in a workspace text file. Fails when oldString is not in the file, " +
    "or occurs more than once unless replaceAll is set; add surrounding lines to make it unique. " +
    "Prefer this over write_file for changing an existing file.",
  parameters: Schema.Struct({
    path: PathParam,
    oldString: Schema.String.annotate({ description: "The exact text to replace" }),
    newString: Schema.String.annotate({ description: "What to put in its place" }),
    replaceAll: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace every occurrence; default false" }),
    ),
  }),
  success: Schema.Struct({ path: Schema.String, replacements: Schema.Number }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "fs:write");

export const DirEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["file", "directory", "other"]),
  /** Bytes; 0 for a directory. */
  size: Schema.Number,
});
export type DirEntry = typeof DirEntry.Type;

export const ListDir = Tool.make("list_dir", {
  description:
    "List the entries of a directory in the workspace, directories first, in name order. " +
    `Shows at most ${LIST_LIMIT} entries.`,
  parameters: Schema.Struct({ path: DirectoryParam }),
  success: Schema.Struct({
    path: Schema.String,
    entries: Schema.Array(DirEntry),
    truncated: Schema.Boolean,
  }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "fs:read");

export const Glob = Tool.make("glob", {
  description:
    'Find files in the workspace whose path matches a glob pattern such as "**/*.ts" or "src/**/*.test.ts". ' +
    "A pattern without a slash matches file names at any depth. " +
    `Paths come back relative to the workspace root, ${GLOB_LIMIT} at most. ` +
    "node_modules, .git, and hidden directories are skipped.",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The glob pattern to match paths against" }),
    path: DirectoryParam,
  }),
  success: Schema.Struct({
    path: Schema.String,
    files: Schema.Array(Schema.String),
    truncated: Schema.Boolean,
  }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "fs:read");

export const GrepMatch = Schema.Struct({
  path: Schema.String,
  /** One-based. */
  line: Schema.Number,
  text: Schema.String,
});
export type GrepMatch = typeof GrepMatch.Type;

export const Grep = Tool.make("grep", {
  description:
    "Search file contents in the workspace with a regular expression in JavaScript syntax. " +
    `Returns matching lines with their path and line number, ${GREP_LIMIT} at most. ` +
    "node_modules, .git, hidden directories, and binary files are skipped.",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The regular expression to search for" }),
    path: DirectoryParam,
    include: Schema.optional(
      Schema.String.annotate({
        description: 'Only search files whose name matches this glob, e.g. "*.ts" or "*.{ts,tsx}"',
      }),
    ),
  }),
  success: Schema.Struct({ matches: Schema.Array(GrepMatch), truncated: Schema.Boolean }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "fs:read");

export const FileTools = Toolkit.make(ReadFile, WriteFile, EditFile, ListDir, Glob, Grep);

/** Files found under a directory, as workspace-relative paths in walk order. */
interface Walked {
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

/** Whether a glob matches a workspace-relative path, or its file name when the pattern has no slash. */
const matches = (glob: Bun.Glob, pattern: string, relative: string, name: string): boolean =>
  glob.match(relative) || (!pattern.includes("/") && glob.match(name));

/** Text with a NUL byte is a binary file, not something to search line by line. */
const isBinary = (text: string): boolean => text.includes("\u0000");

const cutLine = (line: string): string =>
  line.length <= LINE_MAX_CHARS ? line : `${line.slice(0, LINE_MAX_CHARS)}…`;

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

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

  const notFound = (requested: string) =>
    new FileToolError({
      reason: "NotFound",
      path: requested,
      message: `${requested} does not exist`,
    });

  /** The directory a listing or search starts from: the root when none was given. */
  const resolveDirectory = Effect.fn("FileTools.resolveDirectory")(function* (
    requested: string | undefined,
  ) {
    const asked = requested === undefined || requested === "" ? "." : requested;
    const { absolute, relative } = yield* resolveInside(asked);
    const info = yield* fs.stat(absolute).pipe(Effect.option);
    if (Option.isNone(info)) {
      return yield* notFound(asked);
    }
    if (info.value.type !== "Directory") {
      return yield* new FileToolError({
        reason: "NotADirectory",
        path: asked,
        message: `${asked} is not a directory`,
      });
    }
    return { absolute, relative: relative === "" ? "." : relative };
  });

  const compileGlob = Effect.fn("FileTools.compileGlob")(function* (pattern: string) {
    return yield* Effect.try({
      try: () => new Bun.Glob(pattern),
      catch: (error) =>
        new FileToolError({
          reason: "InvalidPattern",
          path: pattern,
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  });

  /**
   * Every file under a directory, depth first with each directory's files
   * before its subdirectories, pruned of what nobody searches. Stops at
   * `limit` files and reports that it did.
   */
  const walk = Effect.fn("FileTools.walk")(function* (start: string, limit: number) {
    const files: Array<string> = [];
    const stack = [start];
    let visited = 0;
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        break;
      }
      if (visited >= WALK_DIR_LIMIT) {
        return { files, truncated: true };
      }
      visited += 1;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      const subdirectories: Array<string> = [];
      for (const name of names.toSorted(byName)) {
        const full = path.join(dir, name);
        // A broken link or a vanished entry is skipped, not a failed search.
        const info = yield* fs.stat(full).pipe(Effect.option);
        if (Option.isNone(info)) {
          continue;
        }
        if (info.value.type === "Directory") {
          if (!pruned(name)) {
            subdirectories.push(full);
          }
          continue;
        }
        if (info.value.type !== "File") {
          continue;
        }
        if (files.length >= limit) {
          const walked: Walked = { files, truncated: true };
          return walked;
        }
        files.push(path.relative(root, full));
      }
      // Reversed so the first subdirectory in name order is walked next.
      stack.push(...subdirectories.toReversed());
    }
    const walked: Walked = { files, truncated: false };
    return walked;
  });

  return FileTools.of({
    read_file: Effect.fn("FileTools.read_file")(function* ({ path: requested }) {
      const { absolute, relative } = yield* resolveInside(requested);
      const exists = yield* fs.exists(absolute).pipe(Effect.mapError(ioError(requested)));
      if (!exists) {
        return yield* notFound(requested);
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

    edit_file: Effect.fn("FileTools.edit_file")(function* ({
      path: requested,
      oldString,
      newString,
      replaceAll,
    }) {
      const { absolute, relative } = yield* resolveInside(requested);
      if (oldString.length === 0) {
        return yield* new FileToolError({
          reason: "NoMatch",
          path: requested,
          message: "oldString is empty; give the exact text to replace, or use write_file",
        });
      }
      if (oldString === newString) {
        return yield* new FileToolError({
          reason: "NoChange",
          path: requested,
          message: "oldString and newString are the same",
        });
      }
      const exists = yield* fs.exists(absolute).pipe(Effect.mapError(ioError(requested)));
      if (!exists) {
        return yield* notFound(requested);
      }
      const before = yield* fs.readFileString(absolute).pipe(Effect.mapError(ioError(requested)));
      const found = countOccurrences(before, oldString);
      if (found === 0) {
        return yield* new FileToolError({
          reason: "NoMatch",
          path: requested,
          message: `oldString was not found in ${requested}`,
        });
      }
      if (found > 1 && replaceAll !== true) {
        return yield* new FileToolError({
          reason: "Ambiguous",
          path: requested,
          message: `oldString occurs ${found} times in ${requested}; add surrounding lines to make it unique, or set replaceAll`,
        });
      }
      // Split and join, so `$` in the replacement is not a pattern.
      const after =
        replaceAll === true
          ? before.split(oldString).join(newString)
          : `${before.slice(0, before.indexOf(oldString))}${newString}${before.slice(before.indexOf(oldString) + oldString.length)}`;
      yield* fs.writeFileString(absolute, after).pipe(Effect.mapError(ioError(requested)));
      return { path: relative, replacements: replaceAll === true ? found : 1 };
    }),

    list_dir: Effect.fn("FileTools.list_dir")(function* ({ path: requested }) {
      const { absolute, relative } = yield* resolveDirectory(requested);
      const names = yield* fs.readDirectory(absolute).pipe(Effect.mapError(ioError(relative)));
      const sorted = names.toSorted(byName);
      const entries: Array<DirEntry> = [];
      for (const name of sorted.slice(0, LIST_LIMIT)) {
        const info = yield* fs.stat(path.join(absolute, name)).pipe(Effect.option);
        if (Option.isNone(info)) {
          entries.push({ name, type: "other", size: 0 });
          continue;
        }
        const type =
          info.value.type === "Directory"
            ? "directory"
            : info.value.type === "File"
              ? "file"
              : "other";
        entries.push({ name, type, size: type === "file" ? Number(info.value.size) : 0 });
      }
      const ordered = [
        ...entries.filter((entry) => entry.type === "directory"),
        ...entries.filter((entry) => entry.type !== "directory"),
      ];
      return { path: relative, entries: ordered, truncated: sorted.length > LIST_LIMIT };
    }),

    glob: Effect.fn("FileTools.glob")(function* ({ pattern, path: requested }) {
      const glob = yield* compileGlob(pattern);
      const { absolute, relative } = yield* resolveDirectory(requested);
      const files: Array<string> = [];
      let truncated = false;
      // The search directory's own prefix is not part of what the pattern sees.
      const walked = yield* walk(absolute, GREP_FILE_LIMIT);
      for (const file of walked.files) {
        const local = relative === "." ? file : path.relative(relative, file);
        if (!matches(glob, pattern, local, path.basename(file))) {
          continue;
        }
        if (files.length >= GLOB_LIMIT) {
          truncated = true;
          break;
        }
        files.push(file);
      }
      return { path: relative, files, truncated: truncated || walked.truncated };
    }),

    grep: Effect.fn("FileTools.grep")(function* ({ pattern, path: requested, include }) {
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern),
        catch: (error) =>
          new FileToolError({
            reason: "InvalidPattern",
            path: pattern,
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      const filter = include === undefined ? undefined : yield* compileGlob(include);
      const { absolute } = yield* resolveDirectory(requested);
      const walked = yield* walk(absolute, GREP_FILE_LIMIT);
      const found: Array<GrepMatch> = [];
      let full = false;
      for (const file of walked.files) {
        if (
          filter !== undefined &&
          include !== undefined &&
          !matches(filter, include, file, path.basename(file))
        ) {
          continue;
        }
        // A file that cannot be read as text is skipped, not a failed search.
        const text = yield* fs.readFileString(path.join(root, file)).pipe(Effect.option);
        if (Option.isNone(text) || isBinary(text.value)) {
          continue;
        }
        const lines = text.value.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined || !regex.test(line)) {
            continue;
          }
          if (found.length >= GREP_LIMIT) {
            full = true;
            break;
          }
          found.push({ path: file, line: i + 1, text: cutLine(line.replace(/\r$/, "")) });
        }
        if (full) {
          break;
        }
      }
      return { matches: found, truncated: full || walked.truncated };
    }),
  });
});

export const FileToolsLayer = FileTools.toLayer(fileToolHandlers);
