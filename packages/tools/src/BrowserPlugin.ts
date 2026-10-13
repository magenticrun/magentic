import { define } from "@magentic/plugin";
import { Effect, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { BrowserBridge, BrowserTools, browserHandlers } from "./Browser.ts";

const CommandReply = Schema.Struct({
  id: Schema.NonEmptyString,
  result: Schema.Json,
});

const json = (body: Schema.Json, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "access-control-allow-origin": "*" },
  });

/**
 * Browser tools served by the user's normally launched Chromium browser. The
 * Helium extension polls `next` and posts completed CDP commands to `result`.
 */
export const browserPlugin = define<never>({
  id: "browser",
  description: "Control selected tabs in the user's normally launched Helium browser.",
  setup: Effect.fn("browserPlugin.setup")(function* (ctx) {
    const bridge = yield* BrowserBridge.make;
    const handlers = yield* BrowserTools.toHandlers(
      browserHandlers.pipe(Effect.provideService(BrowserBridge, bridge)),
    );
    const toolkit = yield* BrowserTools.pipe(Effect.provideContext(handlers));
    yield* ctx.tool.registerToolkit(toolkit);
    yield* ctx.http.route("POST", "next", () =>
      Effect.map(bridge.next, (command) =>
        command === undefined
          ? HttpServerResponse.empty({
              status: 204,
              headers: { "access-control-allow-origin": "*" },
            })
          : json({ id: command.id, method: command.method, params: command.params }),
      ),
    );
    yield* ctx.http.route(
      "POST",
      "result",
      Effect.fn("browserPlugin.result")(function* (request) {
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        const reply = Schema.decodeOption(Schema.fromJsonString(CommandReply))(body);
        if (Option.isNone(reply)) {
          return HttpServerResponse.text("body must be { id, result }", { status: 400 });
        }
        const accepted = yield* bridge.complete(reply.value.id, reply.value.result);
        return json({ accepted });
      }),
    );
  }),
});
