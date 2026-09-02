import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import type { Tool } from "effect/unstable/ai";
import { capabilityOf } from "@magentic/plugin";
import { FileToolError, FileTools, FileToolsLayer, ReadFile, WriteFile } from "./FileTools.ts";
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

/** Narrows a tool result to the FileToolError we expect the model to see. */
const expectFileToolError = (
  result: Tool.Result<typeof ReadFile> | Tool.Result<typeof WriteFile>,
): FileToolError => {
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
    }),
  );
});
