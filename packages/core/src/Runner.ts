import type { AgentDefinition } from "@magentic/plugin";
import type { Principal, RunEvent } from "@magentic/protocol";
import { Context, Effect, Layer, Option, Queue, Ref, type Schema, Stream } from "effect";
import { Chat, LanguageModel, Prompt, type Response, type Tool } from "effect/unstable/ai";
import { estimateContext } from "./ContextEstimate.ts";
import { ConversationStore } from "./ConversationStore.ts";
import { describeCause } from "./Errors.ts";
import { RunEventBus } from "./EventBus.ts";
import { ModelRegistry } from "./plugin/ModelRegistry.ts";
import { ToolRegistry } from "./plugin/ToolRegistry.ts";

export interface RunOptions {
  readonly agent: AgentDefinition;
  readonly principal: Principal;
  readonly input: string;
  /** Continue this conversation; a fresh one starts otherwise. */
  readonly conversationId: Option.Option<string>;
  /** A `provider/model` reference to run on instead of the agent's own. */
  readonly model: Option.Option<string>;
}

/**
 * Turns one input into a stream of events: the model speaks, calls tools,
 * sees their results, and speaks again until it stops calling tools. History
 * is restored from and saved to the ConversationStore around every run.
 */
export class Runner extends Context.Service<
  Runner,
  {
    run(options: RunOptions): Stream.Stream<RunEvent>;
  }
>()("magentic/core/Runner") {
  /** Runs agents with the tools the registry grants each of them. */
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      const models = yield* ModelRegistry;
      const conversations = yield* ConversationStore;
      const bus = yield* RunEventBus;

      const openChat = Effect.fn("Runner.openChat")(function* (
        conversationId: string,
        agent: AgentDefinition,
      ) {
        const saved = yield* conversations.load(conversationId);
        if (Option.isSome(saved)) {
          const restored = yield* Effect.option(Chat.fromJson(saved.value));
          if (Option.isSome(restored)) {
            return restored.value;
          }
        }
        return yield* Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(agent.prompt)));
      });

      const toEvents = (
        part: Response.StreamPart<Record<string, Tool.Any>>,
      ): ReadonlyArray<RunEvent> => {
        switch (part.type) {
          case "text-delta":
            return [{ _tag: "TextDelta", text: part.delta }];
          case "reasoning-delta":
            return [{ _tag: "ReasoningDelta", text: part.delta }];
          case "tool-call":
            // SAFETY: tool parameters were decoded from the model's JSON arguments.
            return [
              {
                _tag: "ToolCall",
                id: part.id,
                name: part.name,
                params: part.params as Schema.Json,
              },
            ];
          case "tool-result":
            return part.preliminary
              ? []
              : [
                  {
                    _tag: "ToolResult",
                    id: part.id,
                    name: part.name,
                    // SAFETY: the encoded result is the JSON form the tool's success/failure schema produced.
                    result: part.encodedResult as Schema.Json,
                    isFailure: part.isFailure,
                  },
                ];
          default:
            return [];
        }
      };

      const run = (options: RunOptions): Stream.Stream<RunEvent> =>
        Stream.callback<RunEvent>((queue) =>
          Effect.gen(function* () {
            const conversationId = Option.getOrElse(options.conversationId, () =>
              crypto.randomUUID(),
            );
            const runId = crypto.randomUUID();
            const agent = options.agent.name;
            const emit = (event: RunEvent) =>
              Effect.andThen(Queue.offer(queue, event), bus.publish({ runId, agent, event }));
            yield* emit({ _tag: "RunStarted", runId, conversationId });

            const chat = yield* openChat(conversationId, options.agent);
            const tools = yield* registry.forAgent(options.agent, {
              runId,
              principal: options.principal,
            });
            const finishReason = yield* Ref.make("unknown");

            const loop = Effect.gen(function* () {
              // Resolved per run so a provider signed in after boot is picked up.
              const model = yield* models.languageModel(
                Option.orElse(options.model, () => Option.fromNullishOr(options.agent.model)),
              );
              let prompt: Prompt.RawInput = options.input;
              while (true) {
                const calledTool = yield* Ref.make(false);
                const usage = yield* Ref.make(Option.none<Response.Usage>());
                yield* chat.streamText({ prompt, toolkit: tools }).pipe(
                  Stream.provideService(LanguageModel.LanguageModel, model),
                  Stream.runForEach((part) =>
                    Effect.gen(function* () {
                      if (part.type === "tool-call") {
                        yield* Ref.set(calledTool, true);
                      }
                      if (part.type === "finish") {
                        yield* Ref.set(finishReason, part.reason);
                        yield* Ref.set(usage, Option.some(part.usage));
                      }
                      for (const event of toEvents(part)) {
                        yield* emit(event);
                      }
                    }),
                  ),
                );
                // Once the call is in the history, so the estimate matches what was counted.
                const reported = yield* Ref.get(usage);
                if (Option.isSome(reported)) {
                  const { inputTokens, outputTokens } = reported.value;
                  yield* emit({
                    _tag: "TokenUsage",
                    inputTokens: inputTokens.total ?? 0,
                    outputTokens: outputTokens.total ?? 0,
                    cacheReadTokens: inputTokens.cacheRead,
                    cacheWriteTokens: inputTokens.cacheWrite,
                    reasoningTokens: outputTokens.reasoning,
                    breakdown: estimateContext(yield* Ref.get(chat.history), tools.tools),
                  });
                }
                if (!(yield* Ref.get(calledTool))) {
                  return;
                }
                // The tool results are already in the history; ask the model to continue.
                prompt = [];
              }
            });

            const outcome = yield* Effect.exit(loop);
            // Keep whatever history we got, even after a failure, so the person can retry.
            yield* chat.exportJson.pipe(
              Effect.flatMap((json) => conversations.save(conversationId, json)),
              Effect.ignore,
            );
            if (outcome._tag === "Failure") {
              yield* emit({ _tag: "RunFailed", message: describeCause(outcome.cause) });
            } else {
              yield* emit({ _tag: "RunFinished", reason: yield* Ref.get(finishReason) });
            }
            yield* Queue.end(queue);
          }),
        );

      return Runner.of({ run });
    }),
  );
}
