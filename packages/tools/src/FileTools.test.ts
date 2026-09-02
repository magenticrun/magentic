import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { AiError, type Tool } from "effect/unstable/ai";
import { capabilityOf } from "@magentic/plugin";
import {
  EditFile,
  FileToolError,
  FileTools,
  FileToolsLayer,
  Glob,
  Grep,
  ListDir,
  ReadFile,
  WriteFile,
} from "./FileTools.ts";
import { WorkspaceRoot } from "./WorkspaceRoot.ts";

/** A fresh temporary workspace per test file, removed when the layer scope closes. */
const WorkspaceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-tools-" });
    return WorkspaceRoot.layer(dir);
  }),
);

const TestLayer = FileToolsLayer.pipe(
  Layer.provideMerge(WorkspaceLayer),
  Layer.provideMerge(BunServices.layer),
);

type AnyResult =
  | Tool.Result<typeof ReadFile>
  | Tool.Result<typeof WriteFile>
  | Tool.Result<typeof EditFile>
  | Tool.Result<typeof ListDir>
  | Tool.Result<typeof Glob>
  | Tool.Result<typeof Grep>;

type FileToolkit = Effect.Success<typeof FileTools>;

/** Puts files in the workspace through the tool itself. */
const seed = (toolkit: FileToolkit, files: Record<string, string>) =>
  Effect.forEach(
    Object.entries(files),
    ([path, content]) =>
      toolkit.handle("write_file", { path, content }).pipe(Effect.flatMap(Stream.runDrain)),
    { discard: true },
  );

/** Narrows a listing to what the model sees when it worked. */
const expectListing = (result: Tool.Result<typeof ListDir>): Tool.Success<typeof ListDir> => {
  if (result instanceof FileToolError || result instanceof AiError.AiError) {
    return assert.fail(`expected a listing, got ${result.message}`);
  }
  return result;
};

/** Narrows a tool result to the FileToolError we expect the model to see. */
const expectFileToolError = (result: AnyResult): FileToolError => {
  if (result instanceof FileToolError) {
    return result;
  }
  return assert.fail(`expected FileToolError, got ${JSON.stringify(result)}`);
};

const lastResult = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((results) => {
      const last = results[results.length - 1];
      assert.isDefined(last);
      return last;
    }),
  );

layer(TestLayer)("file tools", (it) => {
  it.effect("declares capabilities", () =>
    Effect.sync(() => {
      assert.strictEqual(capabilityOf(ReadFile), "fs:read");
      assert.strictEqual(capabilityOf(WriteFile), "fs:write");
      assert.strictEqual(capabilityOf(EditFile), "fs:write");
      assert.strictEqual(capabilityOf(ListDir), "fs:read");
      assert.strictEqual(capabilityOf(Glob), "fs:read");
      assert.strictEqual(capabilityOf(Grep), "fs:read");
    }),
  );

  it.effect("writes then reads a file, creating parent directories", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      const written = yield* toolkit
        .handle("write_file", { path: "notes/today.md", content: "# hi\n" })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(written.isFailure);
      assert.deepStrictEqual(written.result, { path: "notes/today.md", bytes: 5 });

      const read = yield* toolkit
        .handle("read_file", { path: "./notes/../notes/today.md" })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(read.isFailure);
      assert.deepStrictEqual(read.result, { path: "notes/today.md", content: "# hi\n" });
    }),
  );

  it.effect("reports a missing file as a tool failure, not a run failure", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      const read = yield* toolkit
        .handle("read_file", { path: "missing.txt" })
        .pipe(Effect.flatMap(lastResult));
      assert.isTrue(read.isFailure);
      assert.strictEqual(expectFileToolError(read.result).reason, "NotFound");
    }),
  );

  it.effect("refuses paths that escape the workspace", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      for (const path of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
        const result = yield* toolkit
          .handle("write_file", { path, content: "x" })
          .pipe(Effect.flatMap(lastResult));
        assert.isTrue(result.isFailure, path);
        assert.strictEqual(expectFileToolError(result.result).reason, "OutsideWorkspace", path);
      }
      const listed = yield* toolkit
        .handle("list_dir", { path: ".." })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(listed.result).reason, "OutsideWorkspace");
    }),
  );

  it.effect("edits one exact occurrence, and reports a missing or ambiguous one", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      yield* seed(toolkit, { "edit/app.ts": "const a = 1;\nconst b = 1;\nexport { a, b };\n" });
      const ambiguous = yield* toolkit
        .handle("edit_file", { path: "edit/app.ts", oldString: "= 1;", newString: "= 2;" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(ambiguous.result).reason, "Ambiguous");

      const missing = yield* toolkit
        .handle("edit_file", { path: "edit/app.ts", oldString: "= 3;", newString: "= 2;" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(missing.result).reason, "NoMatch");

      const one = yield* toolkit
        .handle("edit_file", {
          path: "edit/app.ts",
          oldString: "const b = 1;",
          newString: "const b = 2; // $& stays literal",
        })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(one.isFailure);
      assert.deepStrictEqual(one.result, { path: "edit/app.ts", replacements: 1 });

      const all = yield* toolkit
        .handle("edit_file", {
          path: "edit/app.ts",
          oldString: "const",
          newString: "let",
          replaceAll: true,
        })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(all.result, { path: "edit/app.ts", replacements: 2 });

      const read = yield* toolkit
        .handle("read_file", { path: "edit/app.ts" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(read.result, {
        path: "edit/app.ts",
        content: "let a = 1;\nlet b = 2; // $& stays literal\nexport { a, b };\n",
      });

      const absent = yield* toolkit
        .handle("edit_file", { path: "edit/nope.ts", oldString: "a", newString: "b" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(absent.result).reason, "NotFound");
    }),
  );

  it.effect("lists a directory with directories first", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      yield* seed(toolkit, { "tree/b.txt": "bb", "tree/a/inner.txt": "x", "tree/c.md": "" });

      const listed = yield* toolkit
        .handle("list_dir", { path: "tree" })
        .pipe(Effect.flatMap(lastResult));
      assert.isFalse(listed.isFailure);
      assert.deepStrictEqual(listed.result, {
        path: "tree",
        entries: [
          { name: "a", type: "directory", size: 0 },
          { name: "b.txt", type: "file", size: 2 },
          { name: "c.md", type: "file", size: 0 },
        ],
        truncated: false,
      });

      const root = expectListing(
        (yield* toolkit.handle("list_dir", {}).pipe(Effect.flatMap(lastResult))).result,
      );
      assert.strictEqual(root.path, ".");
      assert.isTrue(root.entries.some((entry) => entry.name === "tree"));

      const file = yield* toolkit
        .handle("list_dir", { path: "tree/b.txt" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(file.result).reason, "NotADirectory");
    }),
  );

  it.effect("globs by path or by file name, skipping pruned directories", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      yield* seed(toolkit, {
        "proj/src/index.ts": "",
        "proj/src/deep/util.ts": "",
        "proj/README.md": "",
        "proj/node_modules/dep/index.ts": "",
        "proj/.hidden/secret.ts": "",
      });

      const byName = yield* toolkit
        .handle("glob", { pattern: "*.ts", path: "proj" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(byName.result, {
        path: "proj",
        files: ["proj/src/index.ts", "proj/src/deep/util.ts"],
        truncated: false,
      });

      const byPath = yield* toolkit
        .handle("glob", { pattern: "src/deep/*.ts", path: "proj" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(byPath.result, {
        path: "proj",
        files: ["proj/src/deep/util.ts"],
        truncated: false,
      });

      const fromRoot = yield* toolkit
        .handle("glob", { pattern: "proj/**/*.md" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(fromRoot.result, {
        path: ".",
        files: ["proj/README.md"],
        truncated: false,
      });
    }),
  );

  it.effect("greps lines by regex, filtered by an include glob", () =>
    Effect.gen(function* () {
      const toolkit = yield* FileTools;
      yield* seed(toolkit, {
        "search/a.ts": "import x from 'y';\nexport const TODO = 1;\n",
        "search/b.md": "# TODO list\n",
        "search/bin.dat": "TODO\u0000binary",
      });

      const all = yield* toolkit
        .handle("grep", { pattern: "TODO", path: "search" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(all.result, {
        matches: [
          { path: "search/a.ts", line: 2, text: "export const TODO = 1;" },
          { path: "search/b.md", line: 1, text: "# TODO list" },
        ],
        truncated: false,
      });

      const onlyTs = yield* toolkit
        .handle("grep", { pattern: "^export", path: "search", include: "*.ts" })
        .pipe(Effect.flatMap(lastResult));
      assert.deepStrictEqual(onlyTs.result, {
        matches: [{ path: "search/a.ts", line: 2, text: "export const TODO = 1;" }],
        truncated: false,
      });

      const bad = yield* toolkit
        .handle("grep", { pattern: "(", path: "search" })
        .pipe(Effect.flatMap(lastResult));
      assert.strictEqual(expectFileToolError(bad.result).reason, "InvalidPattern");
    }),
  );
});
