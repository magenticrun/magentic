import type { AgentDefinition, ModelCost } from "@magentic/plugin";
import {
  type Attachment,
  type Compacted,
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
import {
  type AiError,
  Chat,
  LanguageModel,
  Prompt,
  type Response,
  type Tool,
} from "effect/unstable/ai";
import {
  compactContext,
  CompactionError,
  isOverflow,
  join,
  keepFor,
  type ModelLimits,
  partition,
} from "./Compaction.ts";
import { estimateContext } from "./ContextEstimate.ts";
import { ConversationStore } from "./ConversationStore.ts";
import { describeCause } from "./Errors.ts";
import { RunEventBus } from "./EventBus.ts";
import { rejectedToolCall, retryPolicy, toRetryEvent } from "./Retry.ts";
import { ModelRegistry } from "./plugin/ModelRegistry.ts";
import { ToolRegistry } from "./plugin/ToolRegistry.ts";
import { type Steer, Steering } from "./Steering.ts";

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
  /** How hard the model should think, one of its `reasoningLevels`; none for its default. */
  readonly reasoning: Option.Option<string>;
}

export interface CompactOptions {
  readonly conversationId: string;
  readonly agent: AgentDefinition;
  /** The `provider/model` to write the summary with; the agent's own otherwise. */
  readonly model: Option.Option<string>;
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

/**
 * Model calls one run may make when the agent does not say. A model that
 * keeps calling tools without ever answering stops here, with `RunFinished`
 * reason `step-limit`, instead of spending until the provider cuts it off.
 */
export const DEFAULT_MAX_STEPS = 50;

/** The `RunFinished` reason for a run that stopped at its step limit. */
export const STEP_LIMIT_REASON = "step-limit";

/**
 * Tool calls one run may have thrown out for bad parameters before it fails
 * with the provider's complaint. A model that cannot match a tool's schema
 * after this many tries will not match it on the next one either.
 */
export const MAX_CORRECTIONS = 3;

/** Arguments echoed back to the model, past which the point is made. */
const PARAMS_SHOWN = 1_000;

const titleOf = (input: string): string => {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
};

/** The usage so far with one more call folded in. */
const foldUsage = (
  previous: Option.Option<ConversationUsage>,
  latest: TokenUsage,
): ConversationUsage => {
  const before = Option.getOrUndefined(previous);
  const spent = before?.totalCost;
  const totalCost = latest.cost === undefined ? spent : (spent ?? 0) + latest.cost;
  const usage: ConversationUsage = {
    latest,
    calls: (before?.calls ?? 0) + 1,
    totalInputTokens: (before?.totalInputTokens ?? 0) + latest.inputTokens,
    totalOutputTokens: (before?.totalOutputTokens ?? 0) + latest.outputTokens,
  };
  return totalCost === undefined ? usage : { ...usage, totalCost };
};

/**
 * What one call cost at the model's prices, in dollars. Cached input is
 * priced apart when the catalog prices it; the rest of the input is priced
 * as input, whether or not the provider said how much was uncached.
 */
const costOf = (price: ModelCost, usage: Response.Usage): number => {
  const cacheRead = usage.inputTokens.cacheRead ?? 0;
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
  const uncached =
    usage.inputTokens.uncached ??
    Math.max(0, (usage.inputTokens.total ?? 0) - cacheRead - cacheWrite);
  const dollars =
    uncached * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    cacheWrite * (price.cacheWrite ?? price.input) +
    (usage.outputTokens.total ?? 0) * price.output;
  return dollars / 1_000_000;
};

/** Steered inputs as one user message: the texts joined by line breaks, every file along. */
const steeredPrompt = (steers: ReadonlyArray<Steer>): Prompt.RawInput =>
  promptOf(
    steers.map((s) => s.input).join("\n"),
    steers.flatMap((s) => s.attachments),
  );

/**
 * What the model hears when the provider threw its tool call out: the
 * complaint and the arguments it sent, neither of which is in the history,
 * after whatever the step was already going to say, so nothing of the input
 * is lost when the very first call is the one thrown out.
 */
const correctionPrompt = (
  prompt: Prompt.RawInput,
  rejected: AiError.ToolParameterValidationError,
): Prompt.RawInput => {
  const params = JSON.stringify(rejected.toolParams);
  const shown = params.length > PARAMS_SHOWN ? `${params.slice(0, PARAMS_SHOWN)}…` : params;
  return Prompt.concat(
    Prompt.make(prompt),
    `Your ${rejected.toolName} call did not run: its arguments ${shown} do not match the tool's ` +
      `schema. ${rejected.description}. Call it again with arguments the schema allows.`,
  );
};

/**
 * A conversation open for a run: the chat holds what the model sees, the
 * archive what earlier compactions folded away, kept so the stored history
 * still shows everything.
 */
interface Opened {
  readonly chat: Chat.Service;
  readonly archived: Ref.Ref<ReadonlyArray<Prompt.Message>>;
}

/**
 * Turns one input into a stream of events: the model speaks, calls tools,
 * sees their results, and speaks again until it stops calling tools and
 * nothing more has been steered in. History is restored from and saved to
 * the ConversationStore around every run, with what the conversation is:
 * its title, model, size, and usage. When the context nears the model's
 * window the conversation is compacted, as `compact` does on request.
 */
export class Runner extends Context.Service<
  Runner,
  {
    run(options: RunOptions): Stream.Stream<RunEvent>;
    /** Fold the conversation so far into a summary the next run continues from. */
    compact(options: CompactOptions): Effect.Effect<Compacted, CompactionError>;
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
      const steering = yield* Steering;

      const openChat = Effect.fn("Runner.openChat")(function* (
        conversationId: string,
        agent: AgentDefinition,
      ) {
        const saved = yield* conversations.history(conversationId);
        if (Option.isSome(saved)) {
          const restored = yield* Effect.option(Chat.fromJson(saved.value));
          if (Option.isSome(restored)) {
            const chat = restored.value;
            const { archived, context } = partition(forModel(yield* Ref.get(chat.history)));
            yield* Ref.set(chat.history, context);
            const opened: Opened = { chat, archived: yield* Ref.make(archived) };
            return opened;
          }
        }
        const chat = yield* Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(agent.prompt)));
        const opened: Opened = {
          chat,
          archived: yield* Ref.make<ReadonlyArray<Prompt.Message>>([]),
        };
        return opened;
      });

      /** The whole history, as the store keeps it. */
      const exportHistory = Effect.fn("Runner.exportHistory")(function* (opened: Opened) {
        const context = yield* Ref.get(opened.chat.history);
        yield* Ref.set(
          opened.chat.history,
          forDisk(join(yield* Ref.get(opened.archived), context)),
        );
        return yield* opened.chat.exportJson;
      });

      /**
       * What the catalog says of the model: its token limits (zeros when
       * unknown), its prices, and the request configuration that makes it
       * think at the level asked for, when it has such a level.
       */
      const infoOf = Effect.fn("Runner.infoOf")(function* (
        choice: Option.Option<string>,
        reasoning: Option.Option<string>,
      ) {
        const none = {
          limits: { context: 0, output: 0 } satisfies ModelLimits,
          cost: Option.none<ModelCost>(),
          thinking: Option.none<Context.Context<never>>(),
        };
        const resolved = yield* models.resolve(choice).pipe(Effect.option);
        if (Option.isNone(resolved)) {
          return none;
        }
        const { provider, model } = resolved.value;
        const info = (yield* provider.models).find((m) => m.id === model);
        const thinking =
          Option.isSome(reasoning) && provider.reasoning !== undefined
            ? yield* provider.reasoning(model, reasoning.value)
            : Option.none<Context.Context<never>>();
        return {
          limits: { context: info?.context ?? 0, output: info?.output ?? 0 } satisfies ModelLimits,
          cost: Option.fromNullishOr(info?.cost),
          thinking,
        };
      });

      /** Compact what the model sees, moving what the summary replaced to the archive. */
      const compactOpened = Effect.fn("Runner.compactOpened")(function* (
        opened: Opened,
        model: LanguageModel.Service,
        keep: number,
      ) {
        const done = yield* compactContext(yield* Ref.get(opened.chat.history), keep).pipe(
          Effect.provideService(LanguageModel.LanguageModel, model),
        );
        yield* Ref.set(opened.chat.history, done.context);
        yield* Ref.update(opened.archived, (archived) => [...archived, ...done.dropped]);
        const event: Compacted = {
          _tag: "Compacted",
          summary: done.summary,
          messagesBefore: done.messagesBefore,
          messagesAfter: done.messagesAfter,
        };
        return event;
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

            const opened = yield* openChat(conversationId, options.agent);
            const { chat } = opened;
            const tools = yield* registry.forAgent(options.agent, {
              runId,
              principal: options.principal,
            });
            const steers = yield* steering.open(runId, options.principal.id);
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
              const { limits, cost, thinking } = yield* infoOf(choice, options.reasoning);
              /** The call with the thinking configuration in its context, when there is one. */
              const withThinking = <A, E, R>(
                stream: Stream.Stream<A, E, R>,
              ): Stream.Stream<A, E, R> =>
                Option.isSome(thinking) ? Stream.provideContext(stream, thinking.value) : stream;
              // A summary that cannot be written is logged, not a failed run.
              const compactIfFull = (held: number) =>
                isOverflow(held, limits)
                  ? Effect.gen(function* () {
                      yield* emit({ _tag: "CompactionStarted" });
                      yield* emit(yield* compactOpened(opened, model, keepFor(limits)));
                    }).pipe(
                      Effect.catchTag("CompactionError", (error) =>
                        Effect.logWarning(`conversation ${conversationId} not compacted`, error),
                      ),
                    )
                  : Effect.void;
              let prompt = promptOf(options.input, options.attachments);
              const maxSteps = options.agent.maxSteps ?? DEFAULT_MAX_STEPS;
              /** Tool calls the provider threw out so far, over the whole run. */
              const corrected = yield* Ref.make(0);
              for (let step = 1; ; step++) {
                const calledTool = yield* Ref.make(false);
                const usage = yield* Ref.make(Option.none<Response.Usage>());
                // A call that fails before anything reached the surface is tried
                // again from the same history: the chat appends the prompt and
                // whatever came back even when the stream fails. One that fails
                // after speaking is not, so nothing shows twice.
                const before = yield* Ref.get(chat.history);
                const spoke = yield* Ref.make(false);
                const attempt = Effect.andThen(
                  Ref.set(chat.history, before),
                  chat.streamText({ prompt, toolkit: tools }).pipe(
                    Stream.provideService(LanguageModel.LanguageModel, model),
                    withThinking,
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
                          yield* Ref.set(spoke, true);
                          yield* emit(event);
                        }
                      }),
                    ),
                  ),
                );
                const call = yield* Effect.exit(
                  Effect.retry(
                    attempt,
                    retryPolicy({
                      canRetry: Effect.map(Ref.get(spoke), (yes) => !yes),
                      onRetry: (retrying) => emit(toRetryEvent(retrying)),
                    }),
                  ),
                );
                if (call._tag === "Failure") {
                  const rejected = rejectedToolCall(call.cause);
                  const corrections = yield* Ref.get(corrected);
                  if (Option.isNone(rejected) || corrections >= MAX_CORRECTIONS) {
                    return yield* call;
                  }
                  // Nothing of a response that died on a bad tool call is in the
                  // history, so the model hears what the call got wrong and takes
                  // the step again rather than the run ending on it.
                  yield* Ref.set(chat.history, before);
                  yield* Ref.update(corrected, (n) => n + 1);
                  yield* emit({
                    _tag: "Retrying",
                    attempt: corrections + 1,
                    limit: MAX_CORRECTIONS,
                    message: rejected.value.message,
                    delayMs: 0,
                  });
                  prompt = correctionPrompt(prompt, rejected.value);
                  continue;
                }
                // Once the call is in the history, so the estimate matches what was counted.
                const reported = yield* Ref.get(usage);
                if (Option.isSome(reported)) {
                  const { inputTokens, outputTokens } = reported.value;
                  const counted: TokenUsage = {
                    _tag: "TokenUsage",
                    inputTokens: inputTokens.total ?? 0,
                    outputTokens: outputTokens.total ?? 0,
                    cacheReadTokens: inputTokens.cacheRead,
                    cacheWriteTokens: inputTokens.cacheWrite,
                    reasoningTokens: outputTokens.reasoning,
                    breakdown: estimateContext(yield* Ref.get(chat.history), tools.tools),
                  };
                  const event: TokenUsage = Option.isSome(cost)
                    ? { ...counted, cost: costOf(cost.value, reported.value) }
                    : counted;
                  yield* Ref.update(usageSoFar, (previous) =>
                    Option.some(foldUsage(previous, event)),
                  );
                  yield* emit(event);
                  yield* compactIfFull(event.inputTokens + event.outputTokens);
                }
                const calledTools = yield* Ref.get(calledTool);
                if (calledTools && step >= maxSteps) {
                  // The tool results are in the history; the next input picks up from them.
                  yield* Ref.set(finishReason, STEP_LIMIT_REASON);
                  yield* Effect.logWarning(
                    `run ${runId} stopped at ${agent}'s step limit of ${maxSteps} model calls`,
                  );
                  return;
                }
                // What was steered in meanwhile goes to the model before it speaks
                // again. A run that has answered and has nothing steered ends,
                // closed to steering in the same step so nothing arrives too late.
                const steered = yield* calledTools ? steers.take : steers.takeOrClose;
                if (steered.length > 0) {
                  yield* emit({ _tag: "Steered", inputs: steered.map((s) => s.input) });
                  prompt = steeredPrompt(steered);
                } else if (calledTools) {
                  // The tool results are already in the history; ask the model to continue.
                  prompt = [];
                } else {
                  return;
                }
              }
            });

            const outcome = yield* Effect.exit(loop);
            // Keep whatever history we got, even after a failure, so the person can retry.
            yield* Effect.gen(function* () {
              const now = yield* DateTime.now;
              const context = yield* Ref.get(chat.history);
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
                messages: context.content.length,
                usage: Option.getOrUndefined(usage),
              });
              yield* conversations.save(info, yield* exportHistory(opened));
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

      const compact = Effect.fn("Runner.compact")(function* (options: CompactOptions) {
        const existing = yield* conversations.get(options.conversationId);
        if (Option.isNone(existing)) {
          return yield* new CompactionError({
            reason: "nothing",
            message: `no conversation ${options.conversationId}`,
          });
        }
        const choice = Option.orElse(options.model, () =>
          Option.fromNullishOr(options.agent.model),
        );
        const model = yield* models
          .languageModel(choice)
          .pipe(
            Effect.mapError(
              (error) => new CompactionError({ reason: "model", message: error.message }),
            ),
          );
        const opened = yield* openChat(options.conversationId, options.agent);
        // Everything goes into the summary: the person asked for a fresh start.
        const event = yield* compactOpened(opened, model, 0);
        const now = yield* DateTime.now;
        const info = new Conversation({
          ...existing.value,
          updatedAt: now,
          messages: event.messagesAfter,
        });
        yield* Effect.flatMap(exportHistory(opened), (json) => conversations.save(info, json)).pipe(
          Effect.mapError(
            (error) => new CompactionError({ reason: "store", message: error.message }),
          ),
        );
        return event;
      });

      return Runner.of({ run, compact });
    }),
  );
}
