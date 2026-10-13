import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { TRACE_CONVERSATION, TraceSpan } from "@magentic/protocol";
import { Effect, FileSystem, Layer, Path, Tracer } from "effect";
import { layerTraceCapture, TraceStore } from "./TraceStore.ts";

/** Every span the tracer underneath was given, as an OTLP exporter would be. */
const exported: Array<Tracer.NativeSpan> = [];

const Underneath = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      exported.push(span);
      return span;
    },
  }),
);

const CaptureLayer = layerTraceCapture.pipe(
  Layer.provide(Underneath),
  Layer.provideMerge(TraceStore.layerMemory),
);

/** A run of conversation `id`, its span starting a trace of its own as the runner's does. */
const run = (id: string) =>
  Effect.withSpan("invoke_agent assistant", {
    root: true,
    attributes: { [TRACE_CONVERSATION]: id },
  });

layer(CaptureLayer)("layerTraceCapture", (it) => {
  it.effect(
    "keeps HTTP headers and unset attributes from the store and the tracer underneath",
    () =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "http.request.header.authorization": "Bearer secret",
          "http.response.header.chatgpt-account-id": "account",
          "http.request.method": "POST",
          unset: undefined,
        }).pipe(Effect.withSpan("http.client POST"), run("headers"));

        const kept = yield* (yield* TraceStore).spans("headers");
        const request = kept.find((span) => span.name === "http.client POST");
        assert.deepStrictEqual(request?.attributes, { "http.request.method": "POST" });
        const sent = exported.find((span) => span.name === "http.client POST");
        assert.deepStrictEqual([...(sent?.attributes.keys() ?? [])], ["http.request.method"]);
      }),
  );

  it.effect("keeps the spans under a run by its conversation, parented within the run", () =>
    Effect.gen(function* () {
      yield* Effect.fail("boom").pipe(
        Effect.withSpan("failing step"),
        Effect.ignore,
        Effect.andThen(Effect.void.pipe(Effect.withSpan("fine step"))),
        run("parented"),
        // What the run was started under, such as the RPC's span, is another trace.
        Effect.withSpan("rpc request"),
      );
      yield* Effect.void.pipe(Effect.withSpan("outside any run"));

      const kept = yield* (yield* TraceStore).spans("parented");
      assert.deepStrictEqual(
        kept.map((span) => span.name),
        ["failing step", "fine step", "invoke_agent assistant"],
      );
      const [failing, fine, root] = kept;
      assert.strictEqual(root?.parentSpanId, undefined);
      assert.strictEqual(failing?.parentSpanId, root?.spanId);
      assert.strictEqual(fine?.parentSpanId, root?.spanId);
      assert.strictEqual(failing?.status, "error");
      assert.include(failing?.error ?? "", "boom");
      assert.strictEqual(fine?.status, "ok");
      assert.isTrue(exported.some((span) => span.name === "outside any run"));
    }),
  );
});

const span = (n: number, padding = "") =>
  new TraceSpan({
    traceId: "t",
    spanId: `s${n}`,
    name: `step ${n}`,
    start: n,
    end: n + 1,
    status: "ok",
    attributes: padding === "" ? {} : { padding },
  });

/** Use a file store over `dir`, closing it after, as the gateway does when it stops. */
const withStore = <A, E, R>(
  dir: string,
  use: (store: TraceStore["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* TraceStore);
  }).pipe(Effect.provide(TraceStore.layerFile(dir)));

layer(BunServices.layer)("TraceStore.layerFile", (it) => {
  it.effect("reads spans before they are written, and after a restart from a private file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-trace-" });

      yield* withStore(dir, (store) =>
        Effect.gen(function* () {
          store.keep("c1", span(1));
          store.keep("c1", span(2));
          store.keep("c2", span(3));
          assert.deepStrictEqual(
            (yield* store.spans("c1")).map((kept) => kept.spanId),
            ["s1", "s2"],
          );
        }),
      );

      const file = path.join(dir, "c1", "trace.jsonl");
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      const reopened = yield* withStore(dir, (store) =>
        Effect.all([store.spans("c1"), store.spans("c2"), store.spans("never")]),
      );
      assert.deepStrictEqual(
        reopened.map((spans) => spans.map((kept) => kept.spanId)),
        [["s1", "s2"], ["s3"], []],
      );
    }),
  );

  it.effect("keeps nothing for an id that is not a plain name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-trace-" });
      const nested = path.join(dir, "inner");

      const read = yield* withStore(nested, (store) => {
        store.keep("../escaped", span(1));
        return store.spans("../escaped");
      });
      assert.deepStrictEqual(read, []);
      assert.isFalse(yield* fs.exists(path.join(dir, "escaped")));
    }),
  );

  it.effect("keeps the newest whole spans once a trace outgrows its cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-trace-" });
      const file = path.join(dir, "big", "trace.jsonl");
      const padding = "x".repeat(1_000);
      const keepMany = (from: number, to: number) =>
        withStore(dir, (store) =>
          Effect.sync(() => {
            for (let n = from; n < to; n++) {
              store.keep("big", span(n, padding));
            }
          }),
        );
      const readBack = Effect.gen(function* () {
        assert.isAtMost(Number((yield* fs.stat(file)).size), 8 * 1024 * 1024);
        return (yield* withStore(dir, (store) => store.spans("big"))).map((kept) => kept.spanId);
      });
      /** The latest spans up to `to`, whole and in order, none lost between. */
      const newestUpTo = (ids: ReadonlyArray<string>, to: number) => {
        assert.isAbove(ids.length, 2_000);
        assert.deepStrictEqual(
          ids,
          Array.from({ length: ids.length }, (_, index) => `s${to - ids.length + index}`),
        );
      };

      // About 9MB at once into no file, past the 8MB cap.
      yield* keepMany(0, 9_000);
      newestUpTo(yield* readBack, 9_000);
      // Then more onto the file that is there.
      yield* keepMany(9_000, 15_000);
      newestUpTo(yield* readBack, 15_000);
    }),
  );
});
