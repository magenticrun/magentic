import type { RunEvent } from "@magentic/protocol";
import { Cause, Duration, Effect, Random, Schedule } from "effect";
import type { AiError } from "effect/unstable/ai";

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
  error.isRetryable && !asksToWaitTooLong(error);

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

/** The event a surface gets for one retry. */
export const toRetryEvent = (retrying: Retrying): RunEvent => ({
  _tag: "Retrying",
  attempt: retrying.attempt,
  limit: retrying.limit,
  message: retrying.error.message,
  delayMs: Duration.toMillis(retrying.delay),
});
