import { assert, layer } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { layerFake } from "./Fake.ts";

const Scripted = layerFake(({ index }) => [
  { type: "text", text: `reply ${index}` },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
]);

layer(Scripted)("fake model", (it) => {
  it.effect("replays the script per call, in order", () =>
    Effect.gen(function* () {
      const first = yield* LanguageModel.generateText({ prompt: "hi" });
      const second = yield* LanguageModel.generateText({ prompt: "again" });
      assert.strictEqual(first.text, "reply 0");
      assert.strictEqual(second.text, "reply 1");
    }),
  );

  it.effect("streams text as deltas", () =>
    Effect.gen(function* () {
      const parts = yield* LanguageModel.streamText({ prompt: "hi" }).pipe(Stream.runCollect);
      const deltas = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
      // The layer is shared across tests, so only the shape is stable, not the index.
      assert.strictEqual(deltas.length, 1);
      assert.match(deltas[0] ?? "", /^reply \d+$/);
    }),
  );
});
