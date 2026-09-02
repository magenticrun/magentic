import { define, ModelInfo } from "@magentic/plugin";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/unstable/ai";

/** Token limits the fake model claims; 0 when a test does not care, as the catalog would say. */
export interface FakeLimits {
  readonly context: number;
  readonly output: number;
  /** What the fake charges, when a test cares. */
  readonly cost?: ModelInfo["cost"];
}

/** The level a run asked the fake to think at; what its `reasoning` hands the runner. */
export const FakeReasoning = Context.Reference<Option.Option<string>>(
  "magentic/model/FakeReasoning",
  {
    defaultValue: () => Option.none(),
  },
);

/** The levels the fake claims its thinking can be set to. */
export const FAKE_REASONING_LEVELS: ReadonlyArray<string> = ["low", "high"];

/**
 * A provider plugin whose model replays `script`. Always "signed in", so a
 * test host with this plugin needs no credentials. Its id is `fake`.
 */
export const fakeProviderPlugin = (script: FakeScript, limits?: FakeLimits) =>
  define({
    id: "fake",
    description: "A scripted model for tests.",
    setup: (ctx) =>
      Effect.asVoid(
        ctx.model.register({
          id: "fake",
          name: "Fake",
          description: "Replays a script.",
          methods: [],
          status: Effect.succeedSome("scripted"),
          logout: Effect.void,
          models: Effect.succeed([
            new ModelInfo({
              id: "fake",
              name: "Fake",
              reasoning: false,
              toolCall: true,
              context: limits?.context ?? 0,
              output: limits?.output ?? 0,
              reasoningLevels: FAKE_REASONING_LEVELS,
              cost: limits?.cost,
            }),
          ]),
          defaultModel: "fake",
          model: () => Effect.succeedSome(layerFake(script)),
          reasoning: (_, level) =>
            Effect.succeed(
              FAKE_REASONING_LEVELS.includes(level)
                ? Option.some(Context.make(FakeReasoning, Option.some(level)))
                : Option.none(),
            ),
        }),
      ),
  });

/** One scripted model turn: what the fake replies with for the nth call, or the error the call fails with. */
export type FakeScript = (call: {
  readonly index: number;
  readonly options: LanguageModel.ProviderOptions;
  /** The level the run asked for, as `FakeReasoning` carries it around the call. */
  readonly reasoning: Option.Option<string>;
}) => ReadonlyArray<Response.PartEncoded> | AiError.AiError;

/** The finish a real provider streams last, with usage counted at one token per part. */
const finish = (parts: ReadonlyArray<Response.PartEncoded>): Response.StreamPartEncoded => ({
  type: "finish",
  reason: parts.some((part) => part.type === "tool-call") ? "tool-calls" : "stop",
  usage: {
    inputTokens: { total: 10, uncached: 10 },
    outputTokens: { total: parts.length },
  },
});

/** Splits a text or reasoning part into the start / delta / end parts a real provider streams. */
const toStreamParts = (
  parts: ReadonlyArray<Response.PartEncoded>,
): Array<Response.StreamPartEncoded> => {
  const out: Array<Response.StreamPartEncoded> = [];
  parts.forEach((part, index) => {
    const id = `part-${index}`;
    switch (part.type) {
      case "text":
        out.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: part.text },
          { type: "text-end", id },
        );
        return;
      case "reasoning":
        out.push(
          { type: "reasoning-start", id },
          { type: "reasoning-delta", id, delta: part.text },
          { type: "reasoning-end", id },
        );
        return;
      default:
        out.push(part);
    }
  });
  return out;
};

/**
 * A LanguageModel that replays a script. Tests use it to drive the runner
 * through tool calls without a network.
 */
export const layerFake = (script: FakeScript): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const next = (options: LanguageModel.ProviderOptions) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(calls, (n) => n + 1);
          const reasoning = yield* FakeReasoning;
          const turn = script({ index, options, reasoning });
          return turn instanceof AiError.AiError ? yield* turn : turn;
        });
      return yield* LanguageModel.make({
        generateText: (options) => next(options).pipe(Effect.map((parts) => [...parts])),
        streamText: (options) =>
          Stream.unwrap(
            next(options).pipe(
              Effect.map((parts) => Stream.fromIterable([...toStreamParts(parts), finish(parts)])),
            ),
          ),
      });
    }),
  );
