import { TRACE_CONVERSATION, TraceSpan } from "@magentic/protocol";
import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Schema,
  Semaphore,
  Tracer,
} from "effect";
import { describeCause } from "./Errors.ts";

/** A string attribute past this is cut: a span is a record of timing, not a place for payloads. */
const ATTRIBUTE_LENGTH = 1_000;
/** An error message past this is cut, for the same reason. */
const ERROR_LENGTH = 2_000;
/**
 * How big one conversation's trace may grow before its oldest spans go. A
 * conversation a loop keeps running for days would otherwise grow without
 * end; halving on the way over keeps rewrites rare.
 */
const TRACE_BYTES = 8 * 1024 * 1024;
/**
 * Attributes no span keeps. Effect's HTTP client records every header of a
 * request and its response, and a provider's carry account ids and session
 * tokens beside the credentials it already redacts; a trace goes to files
 * and collectors, so they are dropped before any tracer sees them.
 */
const DROPPED = /^http\.(request|response)\.header\./;
/** How long finished spans wait to be written together. */
const WRITE_DELAY = "500 millis";

/**
 * The spans each conversation's runs finished, kept so a person can export
 * them and an agent can read how its own runs went. A span ends
 * synchronously, so `keep` is too; the writing happens behind it.
 */
export class TraceStore extends Context.Service<
  TraceStore,
  {
    /** Keep a finished span. Returns at once; it is written in the background. */
    keep(conversationId: string, span: TraceSpan): void;
    /** The conversation's spans in the order they finished; empty when it has none. */
    spans(conversationId: string): Effect.Effect<ReadonlyArray<TraceSpan>>;
  }
>()("magentic/core/TraceStore") {
  /** Lost on restart. Fine for tests. */
  static readonly layerMemory = Layer.effect(
    TraceStore,
    Effect.sync(() => {
      const all = new Map<string, Array<TraceSpan>>();
      return TraceStore.of({
        keep: (conversationId, span) => {
          const kept = all.get(conversationId);
          if (kept === undefined) {
            all.set(conversationId, [span]);
          } else {
            kept.push(span);
          }
        },
        spans: (conversationId) => Effect.sync(() => [...(all.get(conversationId) ?? [])]),
      });
    }),
  );

  /**
   * `trace.jsonl` in each conversation's directory under `dir`, one span a
   * line, beside what the ConversationStore keeps there, so removing a
   * conversation takes its trace with it. Spans wait in memory for a moment
   * and are appended together; a read sees those not yet written too.
   */
  static readonly layerFile = (dir: string) =>
    Layer.effect(
      TraceStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const Line = Schema.fromJsonString(TraceSpan);
        const encodeLine = Schema.encodeEffect(Line);
        const decodeLine = Schema.decodeOption(Line);
        const traceFile = (id: string) => path.join(dir, id, "trace.jsonl");
        /** The ConversationStore's rule: the id becomes a directory name. */
        const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

        /** Finished, not yet on disk, by conversation. */
        let pending = new Map<string, Array<TraceSpan>>();
        const wake = yield* Queue.sliding<void>(1);
        // Writing and reading both hold it, so a read never sees a span twice or not at all.
        const lock = yield* Semaphore.make(1);

        /** A file over the cap keeps the newest half of it, whole lines only. */
        const trimmed = (text: string): string => {
          if (text.length <= TRACE_BYTES) {
            return text;
          }
          const kept = text.slice(text.length - TRACE_BYTES / 2);
          return kept.slice(kept.indexOf("\n") + 1);
        };

        const append = Effect.fn("TraceStore.append")(function* (
          id: string,
          spans: ReadonlyArray<TraceSpan>,
        ) {
          const lines = yield* Effect.forEach(spans, (span) => encodeLine(span));
          const text = `${lines.join("\n")}\n`;
          const file = traceFile(id);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
          const size = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;
          if (size + text.length <= TRACE_BYTES) {
            yield* fs.writeFileString(file, text, { flag: "a", mode: 0o600 });
            return;
          }
          const before = size > 0 ? yield* fs.readFileString(file) : "";
          const whole = trimmed(`${before}${text}`);
          const staging = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
          yield* fs.writeFileString(staging, whole, { mode: 0o600 }).pipe(
            Effect.andThen(fs.rename(staging, file)),
            Effect.onError(() => fs.remove(staging).pipe(Effect.ignore)),
          );
        });

        /** Everything pending, written; what cannot be written is dropped with a warning, not retried forever. */
        const flush = lock.withPermits(1)(
          Effect.gen(function* () {
            const batch = pending;
            pending = new Map();
            for (const [id, spans] of batch) {
              yield* append(id, spans).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`trace of conversation ${id} not written`, cause),
                ),
              );
            }
          }),
        );

        yield* Effect.forever(
          Queue.take(wake).pipe(Effect.andThen(Effect.sleep(WRITE_DELAY)), Effect.andThen(flush)),
        ).pipe(Effect.forkScoped);
        // What finished just before the gateway stopped is still written.
        yield* Effect.addFinalizer(() => flush);

        const keep = (conversationId: string, span: TraceSpan) => {
          if (!SAFE_ID.test(conversationId)) {
            return;
          }
          const waiting = pending.get(conversationId);
          if (waiting === undefined) {
            pending.set(conversationId, [span]);
          } else {
            waiting.push(span);
          }
          Queue.offerUnsafe(wake, undefined);
        };

        const spans = Effect.fn("TraceStore.spans")(
          function* (conversationId: string) {
            if (!SAFE_ID.test(conversationId)) {
              return [];
            }
            return yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const file = traceFile(conversationId);
                const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
                const written = text
                  .split("\n")
                  .flatMap((line) => (line.length === 0 ? [] : Option.toArray(decodeLine(line))));
                return [...written, ...(pending.get(conversationId) ?? [])];
              }),
            );
          },
          Effect.orElseSucceed((): ReadonlyArray<TraceSpan> => []),
        );

        return TraceStore.of({ keep, spans });
      }),
    );
}

const isJson = Schema.is(Schema.Json);

/** A span as the store keeps it, once it has ended. */
const toRecord = <A, E>(span: Tracer.Span, endTime: bigint, exit: Exit.Exit<A, E>): TraceSpan => {
  const attributes: Record<string, Schema.Json> = {};
  for (const [key, value] of span.attributes) {
    if (value === undefined) {
      continue;
    }
    const json = isJson(value) ? value : String(value);
    attributes[key] =
      Predicate.isString(json) && json.length > ATTRIBUTE_LENGTH
        ? `${json.slice(0, ATTRIBUTE_LENGTH)}…`
        : json;
  }
  const status: TraceSpan["status"] = Exit.isSuccess(exit)
    ? "ok"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupted"
      : "error";
  const fields = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    start: Number(span.status.startTime / 1000n),
    end: Number(endTime / 1000n),
    status,
    attributes,
  };
  // A run's span starts a trace, so a parent from another trace is not one to point at.
  const parent = Option.getOrUndefined(span.parent);
  const withParent =
    parent === undefined || parent.traceId !== span.traceId
      ? fields
      : { ...fields, parentSpanId: parent.spanId };
  return new TraceSpan(
    status === "error" && Exit.isFailure(exit)
      ? { ...withParent, error: describeCause(exit.cause).slice(0, ERROR_LENGTH) }
      : withParent,
  );
};

/**
 * The tracer in place, with every span that ends under a conversation's run
 * also handed to the store, and header attributes kept from both. Which conversation a span belongs to is found at
 * its end, by walking up to the run's span, which names it; ancestors'
 * answers are remembered so the walk is short.
 */
const capturing = (inner: Tracer.Tracer, store: TraceStore["Service"]): Tracer.Tracer => {
  const owners = new WeakMap<Tracer.AnySpan, string | null>();
  const ownerOf = (span: Tracer.AnySpan): string | null => {
    const known = owners.get(span);
    if (known !== undefined) {
      return known;
    }
    let found: string | null = null;
    if (span._tag === "Span") {
      const named = span.attributes.get(TRACE_CONVERSATION);
      if (Predicate.isString(named)) {
        found = named;
      } else if (Option.isSome(span.parent)) {
        found = ownerOf(span.parent.value);
      }
    }
    owners.set(span, found);
    return found;
  };
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const span = inner.span(options);
      const wrapped: Tracer.Span = {
        _tag: "Span",
        name: span.name,
        spanId: span.spanId,
        traceId: span.traceId,
        parent: span.parent,
        annotations: span.annotations,
        sampled: span.sampled,
        kind: span.kind,
        get status() {
          return span.status;
        },
        get attributes() {
          return span.attributes;
        },
        get links() {
          return span.links;
        },
        end: (endTime, exit) => {
          span.end(endTime, exit);
          const owner = ownerOf(wrapped);
          if (owner !== null) {
            store.keep(owner, toRecord(wrapped, endTime, exit));
          }
        },
        // An attribute left undefined is one not set, not the string "undefined".
        attribute: (key, value) => {
          if (value !== undefined && !DROPPED.test(key)) {
            span.attribute(key, value);
          }
        },
        event: (name, startTime, attributes) => span.event(name, startTime, attributes),
        addLinks: (links) => span.addLinks(links),
      };
      return wrapped;
    },
  };
  return inner.context === undefined ? tracer : { ...tracer, context: inner.context };
};

/**
 * Keeps each conversation's spans in the `TraceStore`, on top of whatever
 * tracer is already in place, an OTLP exporter or Effect's own, which goes on
 * getting every span as before.
 */
export const layerTraceCapture = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    return capturing(yield* Tracer.Tracer, yield* TraceStore);
  }),
);
