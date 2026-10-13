import type { RunEvent } from "@magentic/protocol";
import { Cause, Duration, Effect, Option, Random, Schedule } from "effect";
import { AiError } from "effect/ai";

/**
 * How a failed model call is tried again, after opencode: backoff from two
 * seconds, doubled each time and jittered, capped at thirty seconds unless
 * the provider said when to come back.
 */
export const RETRY_INITIAL = Duration.seconds(2);
export const RETRY_FACTOR = 2;
export const RETRY_MAX_DELAY = Duration.seconds(30);
/** Tries after the first; the sixth failure is the one reported. */
export const RETRY_LIMIT = 5;
/**
 * The longest `retry-after` a run waits out. A provider asking for more has
 * cut the caller off for a while; the run fails and says so rather than
 * holding the surface for an hour.
 */
export const RETRY_AFTER_MAX = Duration.minutes(2);

/** The model call failed in a way worth another try, and when it comes. */
export interface Retrying {
  readonly attempt: number;
  readonly limit: number;
  readonly error: AiError.AiError;
  readonly delay: Duration.Duration;
}

/**
 * Retryable failures are what Effect's clients mark so: transport errors,
 * rate limits, and provider 5xx. Everything else, such as a bad key, a
 * context overflow, or a content policy refusal, would only fail again.
 */
export const shouldRetry = (error: AiError.AiError): boolean =>
  error.isRetryable && !asksToWaitTooLong(error) && !isUnofferedToolCall(error);

/**
 * Whether the response held a part no schema of the call accepts, which in
 * practice is a call to a tool the model was not offered: Effect decodes a
 * tool call against the offered names, so a made-up or misspelt one fails
 * as the whole part (`at [n]`, with no key under it) rather than a field of
 * it. Effect marks the failure retryable, but the same request would most
 * likely make the same call, and the error does not carry the name, so the
 * model is told what it can call instead of being asked again blind.
 */
export const isUnofferedToolCall = (error: AiError.AiError): boolean =>
  error.reason._tag === "InvalidOutputError" &&
  /^Expected [\s\S]*\n\s*at \[\d+\]$/.test(error.reason.description);

/** Whether the provider's `retry-after` is beyond what a run waits out. */
export const asksToWaitTooLong = (error: AiError.AiError): boolean =>
  error.retryAfter !== undefined &&
  Duration.toMillis(error.retryAfter) > Duration.toMillis(RETRY_AFTER_MAX);

/** The wait before the nth try: the provider's `retry-after` when it sent one, backoff otherwise. */
export const delayFor = (
  attempt: number,
  error: AiError.AiError,
  random: number,
): Duration.Duration => {
  if (error.retryAfter !== undefined) {
    return error.retryAfter;
  }
  const base = Duration.toMillis(RETRY_INITIAL) * RETRY_FACTOR ** (attempt - 1);
  const jittered = base * (0.8 + 0.4 * random);
  return Duration.millis(Math.min(jittered, Duration.toMillis(RETRY_MAX_DELAY)));
};

export interface RetryOptions<R> {
  /** Whether a retry is still possible; false once something reached the surface. */
  readonly canRetry: Effect.Effect<boolean, never, R>;
  /** Runs before each wait, so the surface can say a retry is coming; never for a failure that ends the run. */
  readonly onRetry: (retrying: Retrying) => Effect.Effect<void, never, R>;
}

/** A retry policy over model-call failures. */
export const retryPolicy = <R>(
  options: RetryOptions<R>,
): Schedule.Schedule<number, AiError.AiError, never, R> =>
  Schedule.fromStepWithMetadata<AiError.AiError, number, R, never, never, never>(
    Effect.succeed((meta: Schedule.InputMetadata<AiError.AiError>) => {
      if (asksToWaitTooLong(meta.input)) {
        return Effect.andThen(
          Effect.logWarning(
            `provider asked to retry after ${Duration.format(meta.input.retryAfter ?? Duration.zero)}, ` +
              `more than the ${Duration.format(RETRY_AFTER_MAX)} a run waits; giving up`,
          ),
          Cause.done(meta.attempt),
        );
      }
      if (!shouldRetry(meta.input) || meta.attempt > RETRY_LIMIT) {
        return Cause.done(meta.attempt);
      }
      return Effect.gen(function* () {
        if (!(yield* options.canRetry)) {
          return yield* Cause.done(meta.attempt);
        }
        const delay = delayFor(meta.attempt, meta.input, yield* Random.next);
        yield* options.onRetry({
          attempt: meta.attempt,
          limit: RETRY_LIMIT,
          error: meta.input,
          delay,
        });
        const step: [number, Duration.Duration] = [meta.attempt, delay];
        return step;
      });
    }),
  );

/** The model call's own failure in a cause, when that is what ended the step. */
export const modelFailure = (cause: Cause.Cause<unknown>): Option.Option<AiError.AiError> =>
  Option.flatMap(Cause.findErrorOption(cause), (error) =>
    AiError.isAiError(error) ? Option.some(error) : Option.none(),
  );

/**
 * The tool call thrown out before it ran, when that is what failed the model
 * call, with what to tell the model. An endpoint that does not hold the model
 * to the tool schema lets a parameter of the wrong type through, and a model
 * can name a tool it was never offered; the response then dies with nothing
 * of it in the history, so the model can be told what was wrong and call the
 * tool again. `offered` names the tools the call had.
 */
export const rejectedToolCall = (
  cause: Cause.Cause<unknown>,
  offered: ReadonlyArray<string>,
): Option.Option<{ readonly message: string; readonly complaint: string }> =>
  Option.flatMap(modelFailure(cause), (error) => {
    const { reason } = error;
    if (reason._tag === "ToolParameterValidationError") {
      return Option.some({
        message: reason.message,
        complaint:
          `Your ${reason.toolName} call did not run because its arguments do not match the tool's ` +
          `schema. ${reason.description}. Call it again with arguments the schema allows.`,
      });
    }
    if (isUnofferedToolCall(error)) {
      return Option.some({
        message: "the model called a tool it was not offered",
        complaint:
          offered.length === 0
            ? "Your last response called a tool, but no tools are available for this turn, so nothing ran. Answer in text."
            : "Your last response called a tool that is not available to you, so nothing ran. " +
              `The tools you can call are: ${offered.join(", ")}. Use one of those names exactly, or answer without a tool.`,
      });
    }
    return Option.none();
  });

/**
 * A call the model had already begun answering when it failed: a stream cut
 * partway through, most often. It cannot be tried again, since the surface
 * would show what was said twice, but what arrived is in the history, so the
 * run picks the answer up from there instead of ending on it. This many times
 * over a run: a connection that keeps dying mid-answer will not finish one.
 */
export const MAX_RESUMES = 3;

/**
 * The wait before a call is picked up again, the same backoff a retry takes,
 * so a provider that just dropped the connection is given the same room.
 */
export const resumeDelay = (
  attempt: number,
  error: AiError.AiError,
): Effect.Effect<Duration.Duration> =>
  Effect.map(Random.next, (random) => delayFor(attempt, error, random));

/** The event a surface gets for one retry. */
export const toRetryEvent = (retrying: Retrying): RunEvent => ({
  _tag: "Retrying",
  attempt: retrying.attempt,
  limit: retrying.limit,
  message: retrying.error.message,
  delayMs: Duration.toMillis(retrying.delay),
});

/**
 * What providers say when the prompt is over the model's window, after
 * opencode's list. Effect has no reason of its own for it; it arrives as an
 * invalid request whose text is all there is to go on.
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /is longer than the model'?s context length/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /but the configured context size is/i,
  /model_context_window_exceeded/i,
];

/** Messages that look like an overflow and are a rate limit instead. */
const NOT_OVERFLOW = [
  /rate limit/i,
  /too many requests/i,
  /^(throttling error|service unavailable):/i,
];

/**
 * Whether the provider refused the call because the prompt is over the
 * model's window: something a compaction fixes, where a retry of the same
 * prompt never would.
 */
export const isContextOverflow = (error: AiError.AiError): boolean =>
  !error.isRetryable &&
  !NOT_OVERFLOW.some((pattern) => pattern.test(error.message)) &&
  OVERFLOW_PATTERNS.some((pattern) => pattern.test(error.message));
