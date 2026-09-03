import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { CapabilityAnnotation, messageOf } from "@magentic/plugin";
import { resolveWithin, WorkspaceRoot } from "./WorkspaceRoot.ts";

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
    "TooLarge",
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
/** Lines `read_file` returns at most in one call. */
export const READ_LINE_LIMIT = 2000;
/** Characters `read_file` returns at most in one call: fewer lines when they are long. */
export const READ_MAX_CHARS = 50_000;
/** Files bigger than this are not read at all: a bundle or a dump, for grep or the shell. */
export const READ_FILE_MAX_BYTES = 16 * 1_048_576;
/** Files bigger than this are not searched: a bundle or a data dump, not code. */
export const GREP_FILE_MAX_BYTES = 1_048_576;
/** Files read at once during a search. */
const GREP_CONCURRENCY = 8;
/** Directories a walk enters at most, so a symlink cycle ends. */
const WALK_DIR_LIMIT = 5_000;
/** Entries stat'd at once within one directory. */
const STAT_CONCURRENCY = 32;
/** A matching line is cut here so one minified file cannot fill the result. */
const LINE_MAX_CHARS = 250;

/** Directories a walk never enters: nobody wants matches from these, and they are huge. */
const PRUNED = new Set(["node_modules", ".git"]);
const pruned = (name: string): boolean => PRUNED.has(name) || name.startsWith(".");

const PathParam = Schema.String.annotate({
  description: "Path relative to the workspace root, e.g. src/index.ts",
});

const DirectoryParam = Schema.optionalKey(
  Schema.String.annotate({
    description: "Directory relative to the workspace root; the root itself when omitted",
  }),
);

/** Which lines of the file a cut read holds, one-based and inclusive. */
export const ReadLines = Schema.Struct({
  from: Schema.Int,
  to: Schema.Int,
  total: Schema.Int,
});

export const ReadFile = Tool.make("read_file", {
  description:
    "Read a UTF-8 text file from the workspace, whole when it is small. " +
    `A read stops after ${READ_LINE_LIMIT} lines or ${READ_MAX_CHARS} characters, whichever comes first, and comes back with truncated set and lines.from, lines.to, and lines.total; ` +
    "call again with offset = lines.to + 1 to go on, or use grep to find the part you need. " +
    `A file over ${READ_FILE_MAX_BYTES} bytes is not read: search it with grep or the shell.`,
  parameters: Schema.Struct({
    path: PathParam,
    offset: Schema.optionalKey(
      Schema.Int.annotate({
        description: "The line to start at, counting from 1; the first when omitted",
      }),
    ),
    limit: Schema.optionalKey(
      Schema.Int.annotate({
        description: `How many lines to read at most; ${READ_LINE_LIMIT} when omitted, and never more`,
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    /** Present, and true, only when the content is not the whole file. */
    truncated: Schema.optional(Schema.Boolean),
    /** Which lines `content` holds; present only when it is not the whole file. */
    lines: Schema.optional(ReadLines),
  }),
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
  success: Schema.Struct({ path: Schema.String, bytes: Schema.Finite }),
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
    replaceAll: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Replace every occurrence; default false" }),
    ),
  }),
  success: Schema.Struct({ path: Schema.String, replacements: Schema.Finite }),
  failure: FileToolError,
  failureMode: "return",
})
  .annotate(Tool.Destructive, true)
  .annotate(CapabilityAnnotation, "fs:write");

export const DirEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["file", "directory", "other"]),
  /** Bytes; 0 for a directory. */
  size: Schema.Finite,
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
  line: Schema.Finite,
  text: Schema.String,
});
export type GrepMatch = typeof GrepMatch.Type;

export const Grep = Tool.make("grep", {
  description:
    "Search file contents in the workspace with a regular expression in JavaScript syntax. " +
    `Returns matching lines with their path and line number, ${GREP_LIMIT} at most. ` +
    `node_modules, .git, hidden directories, binary files, and files over ${GREP_FILE_MAX_BYTES} bytes are skipped.`,
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The regular expression to search for" }),
    path: DirectoryParam,
    include: Schema.optionalKey(
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

/** One file a walk found: its workspace-relative path and size in bytes. */
interface WalkedFile {
  readonly path: string;
  readonly size: number;
}

/** Files found under a directory, in walk order. */
interface Walked {
  readonly files: ReadonlyArray<WalkedFile>;
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

/** What one `read_file` call returns of a file: the whole thing, or a page of its lines. */
type Page =
  | { readonly whole: true }
  | { readonly whole: false; readonly content: string; readonly lines: typeof ReadLines.Type };

/**
 * The lines from `offset` (one-based) on, at most `limit` of them and at
 * most `READ_MAX_CHARS` characters, never cutting a line short except a
 * first line longer than that on its own. Whole when that is all of the file.
 */
export const pageOf = (
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): Page => {
  // A trailing line break ends the last line; it does not start an empty one,
  // and an empty file has no lines at all.
  const trailing = text.endsWith("\n");
  const all = text.length === 0 ? [] : (trailing ? text.slice(0, -1) : text).split("\n");
  const total = all.length;
  const from = Math.max(1, offset ?? 1);
  const want = Math.min(READ_LINE_LIMIT, Math.max(1, limit ?? READ_LINE_LIMIT));
  const kept: Array<string> = [];
  let chars = 0;
  for (const line of all.slice(from - 1, from - 1 + want)) {
    if (kept.length > 0 && chars + line.length + 1 > READ_MAX_CHARS) {
      break;
    }
    kept.push(
      kept.length === 0 && line.length > READ_MAX_CHARS ? line.slice(0, READ_MAX_CHARS) : line,
    );
    chars += line.length + 1;
    if (chars > READ_MAX_CHARS) {
      break;
    }
  }
  const to = from - 1 + kept.length;
  const wholeLine = kept.length === 0 || kept[0] === all[from - 1];
  if (from === 1 && to === total && wholeLine) {
    return { whole: true };
  }
  const content = kept.join("\n") + (to === total && trailing && wholeLine ? "\n" : "");
  return { whole: false, content, lines: { from, to, total } };
};

/** Handlers for the file tools. Needs a FileSystem, a Path, and a WorkspaceRoot. */
export const fileToolHandlers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* WorkspaceRoot;

  const ioError = (requested: string) => (error: { readonly message: string }) =>
    new FileToolError({ reason: "IoError", path: requested, message: error.message });

  /** Resolve a user path against the root and refuse anything that escapes it, links included. */
  const resolveInside = Effect.fn("FileTools.resolveInside")(function* (requested: string) {
    const resolved = yield* resolveWithin(root, requested).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(ioError(requested)),
    );
    if (Option.isNone(resolved)) {
      return yield* new FileToolError({
        reason: "OutsideWorkspace",
        path: requested,
        message: `${requested} is outside the workspace`,
      });
    }
    return resolved.value;
  });

  /** The root with links resolved, what every entry's real path is measured against. */
  const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));

  /** Whether an existing entry's real path is under the real root; a link elsewhere is not. */
  const insideReal = (full: string) =>
    Effect.map(fs.realPath(full).pipe(Effect.option), (real) => {
      if (Option.isNone(real)) {
        return false;
      }
      const relative = path.relative(realRoot, real.value);
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });

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
          message: messageOf(error),
        }),
    });
  });

  /**
   * What each entry of a directory is, in the order given. The stats go out
   * together: one at a time, a walk over thousands of files waits on each.
   */
  const statAll = (dir: string, names: ReadonlyArray<string>) =>
    Effect.forEach(
      names,
      (name) => {
        const full = path.join(dir, name);
        return Effect.map(fs.stat(full).pipe(Effect.option), (info) => ({ name, full, info }));
      },
      { concurrency: STAT_CONCURRENCY },
    );

  /**
   * Every file under a directory that `keep` accepts, depth first with each
   * directory's files before its subdirectories, pruned of what nobody
   * searches. Stops at `limit` kept files and reports that it did, so a
   * caller that wants two hundred matches never walks ten thousand files.
   */
  const walk = Effect.fn("FileTools.walk")(function* (
    start: string,
    limit: number,
    keep: (full: string) => boolean = () => true,
  ) {
    const files: Array<WalkedFile> = [];
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
      for (const { name, full, info } of yield* statAll(dir, names.toSorted(byName))) {
        // A broken link or a vanished entry is skipped, not a failed search.
        if (Option.isNone(info)) {
          continue;
        }
        if (info.value.type === "Directory") {
          if (!pruned(name) && (yield* insideReal(full))) {
            subdirectories.push(full);
          }
          continue;
        }
        if (info.value.type !== "File" || !keep(full)) {
          continue;
        }
        if (files.length >= limit) {
          const walked: Walked = { files, truncated: true };
          return walked;
        }
        files.push({ path: path.relative(root, full), size: Number(info.value.size) });
      }
      // Reversed so the first subdirectory in name order is walked next.
      stack.push(...subdirectories.toReversed());
    }
    const walked: Walked = { files, truncated: false };
    return walked;
  });

  return FileTools.of({
    read_file: Effect.fn("FileTools.read_file")(function* ({ path: requested, offset, limit }) {
      const { absolute, relative } = yield* resolveInside(requested);
      const exists = yield* fs.exists(absolute).pipe(Effect.mapError(ioError(requested)));
      if (!exists) {
        return yield* notFound(requested);
      }
      const info = yield* fs.stat(absolute).pipe(Effect.mapError(ioError(requested)));
      if (Number(info.size) > READ_FILE_MAX_BYTES) {
        return yield* new FileToolError({
          reason: "TooLarge",
          path: requested,
          message: `${requested} is ${info.size} bytes, over the ${READ_FILE_MAX_BYTES} the tool reads; search it with grep or the shell`,
        });
      }
      const text = yield* fs.readFileString(absolute).pipe(Effect.mapError(ioError(requested)));
      const page = pageOf(text, offset, limit);
      return page.whole
        ? { path: relative, content: text }
        : { path: relative, content: page.content, truncated: true, lines: page.lines };
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
      for (const { name, info } of yield* statAll(absolute, sorted.slice(0, LIST_LIMIT))) {
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
      // The search directory's own prefix is not part of what the pattern sees,
      // and the walk stops once it has found enough matches.
      const walked = yield* walk(absolute, GLOB_LIMIT, (full) =>
        matches(glob, pattern, path.relative(absolute, full), path.basename(full)),
      );
      return {
        path: relative,
        files: walked.files.map((file) => file.path),
        truncated: walked.truncated,
      };
    }),

    grep: Effect.fn("FileTools.grep")(function* ({ pattern, path: requested, include }) {
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern),
        catch: (error) =>
          new FileToolError({
            reason: "InvalidPattern",
            path: pattern,
            message: messageOf(error),
          }),
      });
      const filter = include === undefined ? undefined : yield* compileGlob(include);
      const { absolute } = yield* resolveDirectory(requested);
      // The include glob prunes the walk, so files it rules out are never read.
      const walked = yield* walk(absolute, GREP_FILE_LIMIT, (full) =>
        filter === undefined || include === undefined
          ? true
          : matches(filter, include, path.relative(root, full), path.basename(full)),
      );

      /** Every matching line of one file, in order; none for what cannot or should not be read. */
      const search = (file: WalkedFile) =>
        Effect.gen(function* () {
          const hits: Array<GrepMatch> = [];
          if (file.size > GREP_FILE_MAX_BYTES) {
            return hits;
          }
          // A link to somewhere outside the workspace is not searched.
          if (!(yield* insideReal(path.join(root, file.path)))) {
            return hits;
          }
          // A file that cannot be read as text is skipped, not a failed search.
          const text = yield* fs.readFileString(path.join(root, file.path)).pipe(Effect.option);
          if (Option.isNone(text) || isBinary(text.value)) {
            return hits;
          }
          const lines = text.value.split("\n");
          for (let i = 0; i < lines.length && hits.length <= GREP_LIMIT; i++) {
            // Without the carriage return of a CRLF file, or `$` would never match.
            const line = lines[i]?.replace(/\r$/, "");
            if (line !== undefined && regex.test(line)) {
              hits.push({ path: file.path, line: i + 1, text: cutLine(line) });
            }
          }
          return hits;
        });

      // Files are read a few at a time, a batch per round so the result keeps
      // walk order and the search can stop as soon as it has enough.
      const found: Array<GrepMatch> = [];
      let full = false;
      for (let at = 0; at < walked.files.length && !full; at += GREP_CONCURRENCY) {
        const batch = walked.files.slice(at, at + GREP_CONCURRENCY);
        const results = yield* Effect.forEach(batch, search, { concurrency: GREP_CONCURRENCY });
        for (const hit of results.flat()) {
          if (found.length >= GREP_LIMIT) {
            full = true;
            break;
          }
          found.push(hit);
        }
      }
      return { matches: found, truncated: full || walked.truncated };
    }),
  });
});

export const FileToolsLayer = FileTools.toLayer(fileToolHandlers);
