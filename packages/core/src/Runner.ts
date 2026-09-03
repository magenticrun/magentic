import { type AgentDefinition, type ModelCost, Notices } from "@magentic/plugin";
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
  Semaphore,
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
import { noticeMessage } from "./Marks.ts";
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

/**
 * A run the harness starts rather than the person: what it has to say, the
 * notices posted since the last run, is the whole input. One that finds
 * nothing to say emits nothing and ends.
 */
export interface WakeOptions {
  readonly agent: AgentDefinition;
  readonly principal: Principal;
  readonly conversationId: string;
  readonly model: Option.Option<string>;
  readonly reasoning: Option.Option<string>;
}

/** What starts a run: the person's input, or what the harness has to say. */
type Turn =
  | {
      readonly kind: "input";
      readonly input: string;
      readonly attachments: ReadonlyArray<Attachment>;
    }
  | { readonly kind: "wake" };

interface StartOptions extends Omit<RunOptions, "input" | "attachments"> {
  readonly turn: Turn;
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
 * What the model hears when it has spent the agent's steps: the tools are
 * gone, so the only thing left to do is say where the work stands. A ceiling
 * that just returns leaves whoever reads the run nothing but tool results,
 * and leaves the model no chance to finish what it was in the middle of.
 */
const STEP_LIMIT_NOTICE =
  "You have reached this agent's step limit, so your tools are gone for the rest of this run. Answer with text only: what you did, what is left undone, and what you would do next.";

/** The `RunFinished` reason for a run that stopped at its step limit. */
export const STEP_LIMIT_REASON = "step-limit";

/** The `RunFinished` reason for a run the surface stopped before it was done. */
export const INTERRUPTED_REASON = "interrupted";

/** What the model reads in place of a result its tool call never got. */
const UNFINISHED_RESULT = {
  error: "The run ended before this tool finished. Call it again if its result is still needed.",
};

/**
 * The history of a run that ended early, whether stopped or failed, as the
 * next call can send it. The chat keeps what the model said up to that
 * point, so a tool call it made may be left without a result, which the
 * providers reject. Each such call gets a failed result saying why, so the
 * next call goes through and the model knows it was cut off. Nothing changes
 * when every call has its result.
 */
const settleUnfinished = (history: Prompt.Prompt): Prompt.Prompt => {
  const answered = new Set<string>();
  const calls: Array<Prompt.ToolCallPart> = [];
  for (const message of history.content) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && !part.providerExecuted) {
          calls.push(part);
        } else if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    }
  }
  const open = calls.filter((call) => !answered.has(call.id));
  if (open.length === 0) {
    return history;
  }
  const results = Prompt.makeMessage("tool", {
    content: open.map((call) =>
      Prompt.makePart("tool-result", {
        id: call.id,
        name: call.name,
        isFailure: true,
        result: UNFINISHED_RESULT,
        providerExecuted: false,
      }),
    ),
  });
  return Prompt.fromMessages([...history.content, results]);
};

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

/** The notices, when there are any, as a message of their own before the input. */
const withNotices = (notices: ReadonlyArray<string>, input: Prompt.RawInput): Prompt.RawInput =>
  notices.length === 0
    ? input
    : Prompt.concat(Prompt.fromMessages([noticeMessage(notices)]), input);

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
    /**
     * Speak to what the harness posted for the conversation since its last
     * run, as `run` would to an input. Waits for a run in flight on the
     * conversation to end first; one that took the notices leaves it nothing
     * to do, and it ends without an event.
     */
    wake(options: WakeOptions): Stream.Stream<RunEvent>;
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
      const notices = yield* Notices;

      /**
       * The conversation's chat, restored from the store when it has one. A
       * history that cannot be read fails rather than being started over: the
       * fresh chat would be saved over it at the end of the run.
       */
      const openChat = Effect.fn("Runner.openChat")(function* (
        conversationId: string,
        agent: AgentDefinition,
      ) {
        const saved = yield* conversations.history(conversationId);
        if (Option.isNone(saved)) {
          const chat = yield* Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(agent.prompt)));
          const opened: Opened = {
            chat,
            archived: yield* Ref.make<ReadonlyArray<Prompt.Message>>([]),
          };
          return opened;
        }
        const chat = yield* Chat.fromJson(saved.value);
        const { archived, context } = partition(forModel(yield* Ref.get(chat.history)));
        // The agent's prompt as it is now, not as it was when the conversation began.
        yield* Ref.set(chat.history, Prompt.setSystem(context, agent.prompt));
        const opened: Opened = { chat, archived: yield* Ref.make(archived) };
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

      /**
       * One call's usage as the surface hears it: the provider's counts, the
       * cost at the model's prices when the catalog has them, and where the
       * context now goes.
       */
      const tokenUsage = (
        reported: Response.Usage,
        cost: Option.Option<ModelCost>,
        history: Prompt.Prompt,
        tools: Record<string, Tool.Any>,
      ): TokenUsage => {
        const { inputTokens, outputTokens } = reported;
        const counted: TokenUsage = {
          _tag: "TokenUsage",
          inputTokens: inputTokens.total ?? 0,
          outputTokens: outputTokens.total ?? 0,
          cacheReadTokens: inputTokens.cacheRead,
          cacheWriteTokens: inputTokens.cacheWrite,
          reasoningTokens: outputTokens.reasoning,
          breakdown: estimateContext(history, tools),
        };
        return Option.isSome(cost) ? { ...counted, cost: costOf(cost.value, reported) } : counted;
      };

      /**
       * Compact what the model sees, moving what the summary replaced to the
       * archive. The summary call's usage comes back with the event so the
       * caller counts it: it is a model call like any other.
       */
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
        return { event, usage: done.usage };
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

      // One run at a time on a conversation: two at once would each restore
      // the history and save over the other's. The rest wait their turn.
      const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
      const lockFor = Effect.fnUntraced(function* (conversationId: string) {
        const found = (yield* Ref.get(locks)).get(conversationId);
        if (found !== undefined) {
          return found;
        }
        const fresh = yield* Semaphore.make(1);
        return yield* Ref.modify(
          locks,
          (all): [Semaphore.Semaphore, Map<string, Semaphore.Semaphore>] => {
            const raced = all.get(conversationId);
            return raced === undefined
              ? [fresh, new Map(all).set(conversationId, fresh)]
              : [raced, all];
          },
        );
      });

      const start = (options: StartOptions): Stream.Stream<RunEvent> =>
        Stream.callback<RunEvent>((queue) =>
          Effect.gen(function* () {
            const conversationId = Option.getOrElse(options.conversationId, () =>
              crypto.randomUUID(),
            );
            const runId = crypto.randomUUID();
            const agent = options.agent.name;
            const principal = options.principal.id;
            const { turn } = options;
            const emit = (event: RunEvent) =>
              Effect.andThen(Queue.offer(queue, event), bus.publish({ runId, agent, event }));
            // An input opens to steering and says it started before waiting
            // its turn, so a message sent as soon as the surface hears of the
            // run is steered in, not turned away. A wake-up says nothing
            // until it knows it has something to say.
            const openedEarly =
              turn.kind === "input"
                ? Option.some(yield* steering.open(runId, principal))
                : Option.none();
            if (turn.kind === "input") {
              yield* emit({ _tag: "RunStarted", runId, conversationId });
            }
            const lock = yield* lockFor(conversationId);
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const existing = yield* conversations.get(conversationId);
                // A conversation that is not the principal's is not theirs to wake.
                if (
                  turn.kind === "wake" &&
                  Option.isSome(existing) &&
                  existing.value.principal !== principal
                ) {
                  return;
                }
                // What the harness had to say since the last run goes before
                // the input; for a wake-up it is the input, and a run that got
                // here first and took it leaves nothing to do.
                const waiting = yield* notices.take(conversationId);
                if (turn.kind === "wake" && waiting.length === 0) {
                  return;
                }
                const steers = Option.isSome(openedEarly)
                  ? openedEarly.value
                  : yield* steering.open(runId, principal);
                if (turn.kind === "wake") {
                  yield* emit({ _tag: "RunStarted", runId, conversationId });
                }
                if (waiting.length > 0) {
                  yield* emit({ _tag: "Notified", notices: waiting });
                }
                const opening = withNotices(
                  waiting,
                  turn.kind === "input" ? promptOf(turn.input, turn.attachments) : [],
                );

                const restored = yield* Effect.result(openChat(conversationId, options.agent));
                if (restored._tag === "Failure") {
                  yield* emit({
                    _tag: "RunFailed",
                    message: `conversation ${conversationId} cannot be read: ${restored.failure.message}`,
                  });
                  return;
                }
                const opened = restored.success;
                const { chat } = opened;
                const tools = yield* registry.forAgent(options.agent, {
                  runId,
                  conversationId,
                  principal: options.principal,
                });
                const finishReason = yield* Ref.make("unknown");
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
                    Option.isSome(thinking)
                      ? Stream.provideContext(stream, thinking.value)
                      : stream;
                  // A summary that cannot be written is logged, not a failed run.
                  const compactIfFull = (held: number) =>
                    isOverflow(held, limits)
                      ? Effect.gen(function* () {
                          yield* emit({ _tag: "CompactionStarted" });
                          const done = yield* compactOpened(opened, model, keepFor(limits));
                          yield* emit(done.event);
                          const summarised = tokenUsage(
                            done.usage,
                            cost,
                            yield* Ref.get(chat.history),
                            tools.tools,
                          );
                          yield* Ref.update(usageSoFar, (previous) =>
                            Option.some(foldUsage(previous, summarised)),
                          );
                          yield* emit(summarised);
                        }).pipe(
                          Effect.catchTag("CompactionError", (error) =>
                            Effect.logWarning(
                              `conversation ${conversationId} not compacted`,
                              error,
                            ),
                          ),
                        )
                      : Effect.void;
                  let prompt = opening;
                  // Absent, the agent runs as long as it keeps working; a number is
                  // the ceiling, and the step it lands on is spent saying where the
                  // work stands rather than on more of it.
                  const ceiling = Option.fromNullishOr(options.agent.maxSteps);
                  /** The toolkit of a closing turn: every tool gone, the handler unused. */
                  const bare: typeof tools = { ...tools, tools: {} };
                  /** Whether this step is that closing turn. */
                  let closing = false;
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
                      chat.streamText({ prompt, toolkit: closing ? bare : tools }).pipe(
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
                      const event = tokenUsage(
                        reported.value,
                        cost,
                        yield* Ref.get(chat.history),
                        tools.tools,
                      );
                      yield* Ref.update(usageSoFar, (previous) =>
                        Option.some(foldUsage(previous, event)),
                      );
                      yield* emit(event);
                      yield* compactIfFull(event.inputTokens + event.outputTokens);
                    }
                    // The account of the work is the last thing a run over its
                    // ceiling does, whatever the model made of the notice asking
                    // for it.
                    if (closing) {
                      yield* Ref.set(finishReason, STEP_LIMIT_REASON);
                      return;
                    }
                    const calledTools = yield* Ref.get(calledTool);
                    if (calledTools && Option.isSome(ceiling) && step >= ceiling.value) {
                      // The tool results are in the history; the next input picks up from them.
                      yield* Effect.logWarning(
                        `run ${runId} reached ${agent}'s step limit of ${ceiling.value} model calls`,
                      );
                      closing = true;
                      prompt = withNotices([STEP_LIMIT_NOTICE], []);
                      continue;
                    }
                    // What was steered in meanwhile, and what the harness has to say,
                    // go to the model before it speaks again; the notices first, as
                    // they came before the person's reply to them. A run that has
                    // answered and has neither ends, closed to steering in the same
                    // step so nothing arrives too late; a notice that lands after
                    // the check wakes the conversation when a surface follows it,
                    // and waits for the next run otherwise.
                    const noticed = yield* notices.take(conversationId);
                    const steered = yield* calledTools || noticed.length > 0
                      ? steers.take
                      : steers.takeOrClose;
                    if (noticed.length > 0) {
                      yield* emit({ _tag: "Notified", notices: noticed });
                    }
                    if (steered.length > 0) {
                      yield* emit({ _tag: "Steered", inputs: steered.map((s) => s.input) });
                      prompt = withNotices(noticed, steeredPrompt(steered));
                    } else if (noticed.length > 0) {
                      prompt = withNotices(noticed, []);
                    } else if (calledTools) {
                      // The tool results are already in the history; ask the model to continue.
                      prompt = [];
                    } else {
                      return;
                    }
                  }
                });

                // Keep whatever history we got, even after a failure, so the person can retry.
                const save = Effect.gen(function* () {
                  const now = yield* DateTime.now;
                  const context = yield* Ref.get(chat.history);
                  const resolved = yield* models.resolve(choice).pipe(Effect.option);
                  const model = Option.map(resolved, (r) => r.ref);
                  const usage = yield* Ref.get(usageSoFar);
                  const info = new Conversation({
                    id: conversationId,
                    agent,
                    principal,
                    title: Option.match(existing, {
                      // A wake-up never starts a conversation; the notice names it should one slip through.
                      onNone: () => titleOf(turn.kind === "input" ? turn.input : waiting.join(" ")),
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

                // A surface that stops the run interrupts this fiber, and an
                // interrupted fiber runs nothing past the loop but its finalizers.
                // The turn is saved all the same, with what the model said so far,
                // so the next input follows it rather than a history in which the
                // stopped input was never sent. A run that fails mid-turn is saved
                // the same way: a tool call left open would fail every call after.
                const outcome = yield* Effect.exit(loop).pipe(
                  Effect.onInterrupt(() =>
                    Effect.gen(function* () {
                      yield* Ref.update(chat.history, settleUnfinished);
                      yield* save;
                      yield* emit({ _tag: "RunFinished", reason: INTERRUPTED_REASON });
                      yield* Queue.end(queue);
                    }),
                  ),
                );
                yield* Ref.update(chat.history, settleUnfinished);
                yield* save;
                if (outcome._tag === "Failure") {
                  yield* emit({ _tag: "RunFailed", message: describeCause(outcome.cause) });
                } else {
                  yield* emit({ _tag: "RunFinished", reason: yield* Ref.get(finishReason) });
                }
              }),
            );
            yield* Queue.end(queue);
          }),
        );

      const run = (options: RunOptions): Stream.Stream<RunEvent> =>
        start({
          ...options,
          turn: { kind: "input", input: options.input, attachments: options.attachments },
        });

      const wake = (options: WakeOptions): Stream.Stream<RunEvent> =>
        start({
          agent: options.agent,
          principal: options.principal,
          conversationId: Option.some(options.conversationId),
          model: options.model,
          directory: Option.none(),
          reasoning: options.reasoning,
          turn: { kind: "wake" },
        });

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
        const opened = yield* openChat(options.conversationId, options.agent).pipe(
          Effect.mapError(
            (error) =>
              new CompactionError({
                reason: "store",
                message: `conversation ${options.conversationId} cannot be read: ${error.message}`,
              }),
          ),
        );
        // Everything goes into the summary: the person asked for a fresh start.
        const { event, usage } = yield* compactOpened(opened, model, 0);
        const { cost } = yield* infoOf(choice, Option.none());
        // No tools are offered to the summariser, so none are in the estimate.
        const summarised = tokenUsage(usage, cost, yield* Ref.get(opened.chat.history), {});
        const now = yield* DateTime.now;
        const info = new Conversation({
          ...existing.value,
          updatedAt: now,
          messages: event.messagesAfter,
          usage: foldUsage(Option.fromNullishOr(existing.value.usage), summarised),
        });
        yield* Effect.flatMap(exportHistory(opened), (json) => conversations.save(info, json)).pipe(
          Effect.mapError(
            (error) => new CompactionError({ reason: "store", message: error.message }),
          ),
        );
        return event;
      });

      return Runner.of({ run, wake, compact });
    }),
  );
}
