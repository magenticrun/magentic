import type { AgentDefinition } from "@magentic/plugin";
import {
  type Attachment,
  Conversation,
  type ConversationUsage,
  type Principal,
  type RunEvent,
  type TokenUsage,
} from "@magentic/protocol";
import {
  Context,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Result,
  type Schema,
  Stream,
} from "effect";
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
  /** Files that go with the input, as parts of the same user message. */
  readonly attachments: ReadonlyArray<Attachment>;
  /** Continue this conversation; a fresh one starts otherwise. */
  readonly conversationId: Option.Option<string>;
  /** A `provider/model` reference to run on instead of the agent's own. */
  readonly model: Option.Option<string>;
  /** Where the surface is working; kept on the conversation from its first run. */
  readonly directory: Option.Option<string>;
}

/** The input as the model sees it: bare text, or one user message carrying the files too. */
const promptOf = (input: string, attachments: ReadonlyArray<Attachment>): Prompt.RawInput => {
  if (attachments.length === 0) {
    return input;
  }
  const message: Prompt.UserMessageEncoded = {
    role: "user",
    content: [
      { type: "text", text: input },
      ...attachments.map((file): Prompt.FilePartEncoded => ({
        type: "file",
        mediaType: file.mediaType,
        data: file.data,
        fileName: file.fileName,
      })),
    ],
  };
  return [message];
};

/** The prompt with every file part of a user message passed through `f`. */
const mapFileParts = (
  prompt: Prompt.Prompt,
  f: (part: Prompt.FilePart) => Prompt.FilePart,
): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.map((message) =>
      message.role === "user"
        ? Prompt.makeMessage("user", {
            ...message,
            content: message.content.map((part) => (part.type === "file" ? f(part) : part)),
          })
        : message,
    ),
  );

/**
 * Images reach the model as bytes: Effect's clients base64-encode a byte
 * array but encode a string that already is base64 once more. The history's
 * JSON cannot hold bytes, so on disk they are base64 and bytes again on load.
 */
const forDisk = (prompt: Prompt.Prompt): Prompt.Prompt =>
  mapFileParts(prompt, (part) =>
    Predicate.isUint8Array(part.data)
      ? Prompt.makePart("file", { ...part, data: Encoding.encodeBase64(part.data) })
      : part,
  );

const forModel = (prompt: Prompt.Prompt): Prompt.Prompt =>
  mapFileParts(prompt, (part) => {
    if (!part.mediaType.startsWith("image/") || !Predicate.isString(part.data)) {
      return part;
    }
    return Result.match(Encoding.decodeBase64(part.data), {
      onFailure: () => part,
      onSuccess: (bytes) => Prompt.makePart("file", { ...part, data: bytes }),
    });
  });

/** How much of the first input names the conversation. */
const TITLE_LENGTH = 80;

const titleOf = (input: string): string => {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
};

/** The usage so far with one more call folded in. */
const foldUsage = (
  previous: Option.Option<ConversationUsage>,
  latest: TokenUsage,
): ConversationUsage => ({
  latest,
  calls: Option.match(previous, { onNone: () => 1, onSome: (u) => u.calls + 1 }),
  totalInputTokens:
    Option.match(previous, { onNone: () => 0, onSome: (u) => u.totalInputTokens }) +
    latest.inputTokens,
  totalOutputTokens:
    Option.match(previous, { onNone: () => 0, onSome: (u) => u.totalOutputTokens }) +
    latest.outputTokens,
});

/**
 * Turns one input into a stream of events: the model speaks, calls tools,
 * sees their results, and speaks again until it stops calling tools. History
 * is restored from and saved to the ConversationStore around every run, with
 * what the conversation is: its title, model, size, and usage.
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
        const saved = yield* conversations.history(conversationId);
        if (Option.isSome(saved)) {
          const restored = yield* Effect.option(Chat.fromJson(saved.value));
          if (Option.isSome(restored)) {
            yield* Ref.update(restored.value.history, forModel);
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
            const existing = yield* conversations.get(conversationId);
            const usageSoFar = yield* Ref.make(
              Option.flatMap(existing, (info) => Option.fromNullishOr(info.usage)),
            );
            const choice = Option.orElse(options.model, () =>
              Option.fromNullishOr(options.agent.model),
            );

            const loop = Effect.gen(function* () {
              // Resolved per run so a provider signed in after boot is picked up.
              const model = yield* models.languageModel(choice);
              let prompt = promptOf(options.input, options.attachments);
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
                  const event: TokenUsage = {
                    _tag: "TokenUsage",
                    inputTokens: inputTokens.total ?? 0,
                    outputTokens: outputTokens.total ?? 0,
                    cacheReadTokens: inputTokens.cacheRead,
                    cacheWriteTokens: inputTokens.cacheWrite,
                    reasoningTokens: outputTokens.reasoning,
                    breakdown: estimateContext(yield* Ref.get(chat.history), tools.tools),
                  };
                  yield* Ref.update(usageSoFar, (previous) =>
                    Option.some(foldUsage(previous, event)),
                  );
                  yield* emit(event);
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
            yield* Effect.gen(function* () {
              const now = yield* DateTime.now;
              const history = yield* Ref.get(chat.history);
              const resolved = yield* models.resolve(choice).pipe(Effect.option);
              const model = Option.map(resolved, (r) => r.ref);
              const usage = yield* Ref.get(usageSoFar);
              const info = new Conversation({
                id: conversationId,
                agent,
                principal: options.principal.id,
                title: Option.match(existing, {
                  onNone: () => titleOf(options.input),
                  onSome: (before) => before.title,
                }),
                model: Option.getOrUndefined(model),
                directory: Option.match(existing, {
                  onNone: () => Option.getOrUndefined(options.directory),
                  onSome: (before) => before.directory,
                }),
                createdAt: Option.match(existing, {
                  onNone: () => now,
                  onSome: (before) => before.createdAt,
                }),
                updatedAt: now,
                messages: history.content.length,
                usage: Option.getOrUndefined(usage),
              });
              yield* Ref.update(chat.history, forDisk);
              yield* conversations.save(info, yield* chat.exportJson);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`conversation ${conversationId} not saved`, cause),
              ),
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
