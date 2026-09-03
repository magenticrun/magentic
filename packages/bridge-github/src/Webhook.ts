import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRouteHandler } from "@magentic/plugin";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { Headers, HttpServerResponse } from "effect/unstable/http";
import { type GitHubApi, GitHubApiError } from "./GitHubApi.ts";
import type { BridgeState } from "./State.ts";

/** One webhook delivery, as the receiver hands it on. */
export interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly payload: Schema.Json;
}

export interface WebhookOptions {
  readonly secret: Option.Option<Redacted.Redacted<string>>;
  readonly state: BridgeState["Service"];
  /** Takes the delivery off the request's hands; must return at once. */
  readonly enqueue: (delivery: Delivery) => Effect.Effect<void>;
}

/** Whether `signature` is GitHub's HMAC of `body` under `secret`, compared in constant time. */
export const signatureMatches = (
  secret: Redacted.Redacted<string>,
  body: string,
  signature: string,
): boolean => {
  const expected = `sha256=${createHmac("sha256", Redacted.value(secret)).update(body, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
};

const answer = (status: number, text: string) => HttpServerResponse.text(text, { status });

/**
 * The receiver at `/plugins/github/webhook`. It verifies the signature on
 * the raw body, drops a delivery it has seen, checks the event name is
 * there, puts the delivery on the queue, and answers 202 inside GitHub's
 * ten-second window. Nothing here waits on the model.
 */
export const webhookRoute = (options: WebhookOptions): HttpRouteHandler<never> =>
  Effect.fn("githubBridge.webhook")(function* (request) {
    if (Option.isNone(options.secret)) {
      return answer(503, "GITHUB_WEBHOOK_SECRET is not set, so deliveries cannot be verified");
    }
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const signature = Option.getOrElse(
      Headers.get(request.headers, "x-hub-signature-256"),
      () => "",
    );
    if (signature === "" || !signatureMatches(options.secret.value, body, signature)) {
      return answer(401, "signature missing or wrong");
    }
    const id = Option.getOrElse(Headers.get(request.headers, "x-github-delivery"), () => "");
    const event = Option.getOrElse(Headers.get(request.headers, "x-github-event"), () => "");
    if (id === "" || event === "") {
      return answer(400, "X-GitHub-Delivery and X-GitHub-Event are required");
    }
    if (event === "ping") {
      return answer(200, "pong");
    }
    const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Json))(body);
    if (Option.isNone(parsed)) {
      return answer(400, "body is not JSON");
    }
    if (yield* options.state.seenDelivery(id)) {
      return answer(200, "already handled");
    }
    yield* options.enqueue({ id, event, payload: parsed.value });
    return answer(202, "queued");
  });

/**
 * Delivery ids are wider than 2^53, so `JSON.parse` would round them and a
 * redelivery would name the wrong one: the body is read as text and the ids
 * quoted before parsing.
 */
const quoteIds = (text: string) => text.replace(/"id":\s*(\d+)/g, '"id":"$1"');

const HookDeliveries = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    guid: Schema.String,
    delivered_at: Schema.String,
    redelivery: Schema.Boolean,
    status_code: Schema.Int,
    event: Schema.String,
  }),
);

/** Failures older than this are not worth redelivering on a first sweep. */
const FIRST_SWEEP_WINDOW = "1 day";

/**
 * GitHub does not redeliver a failed delivery on its own, so the bridge
 * asks for the ones that failed since it last looked: on start, since
 * being down is when deliveries fail, and then on a schedule. Only first
 * attempts are asked for again, so a delivery that keeps failing does not
 * loop.
 */
export const redeliverFailed = (api: GitHubApi["Service"], state: BridgeState["Service"]) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const since = Option.getOrElse(yield* state.lastSweepAt, () =>
      DateTime.formatIso(DateTime.subtractDuration(now, FIRST_SWEEP_WINDOW)),
    );
    const listed = yield* api.request({ _tag: "App" }, "GET", "/app/hook/deliveries", {
      query: { per_page: "100" },
      raw: true,
      schema: Schema.String,
    });
    const deliveries = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HookDeliveries))(
      quoteIds(listed.body),
    ).pipe(
      Effect.mapError(
        (error) =>
          new GitHubApiError({
            reason: "Decode",
            status: listed.status,
            call: "GET /app/hook/deliveries",
            message: error.message,
          }),
      ),
    );
    const failed = deliveries.filter(
      (delivery) =>
        !delivery.redelivery &&
        delivery.delivered_at > since &&
        (delivery.status_code < 200 || delivery.status_code >= 300),
    );
    for (const delivery of failed) {
      yield* Effect.logInfo(
        `github bridge: asking for delivery ${delivery.guid} (${delivery.event}, status ${delivery.status_code}) again`,
      );
      yield* api
        .request({ _tag: "App" }, "POST", `/app/hook/deliveries/${delivery.id}/attempts`, {
          schema: Schema.NullOr(Schema.Json),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `github bridge: redelivery of ${delivery.guid} refused: ${error.message}`,
            ),
          ),
        );
    }
    yield* state.setLastSweep(DateTime.formatIso(now));
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`github bridge: cannot list webhook deliveries: ${error.message}`),
    ),
  );
