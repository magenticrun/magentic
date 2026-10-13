import { CapabilityAnnotation } from "@magentic/plugin";
import { Context, Deferred, Duration, Effect, Option, Queue, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  reason: Schema.Literals(["Unavailable", "Timeout", "Rejected"]),
  message: Schema.String,
}) {}

export interface BrowserCommand {
  readonly id: string;
  readonly method: string;
  readonly params: Schema.Json;
}

/** How long `next` holds an otherwise empty request open before answering 204. */
const HOLD = Duration.seconds(25);

/** How long a command waits for the extension's reply. */
const REPLY_TIMEOUT = Duration.seconds(30);

/**
 * A local Helium extension long-polls this broker and runs each command against
 * the normally launched browser through chrome.debugger. Keeping the transport
 * in the gateway means tools never need a debug port or a second browser
 * profile.
 */
export class BrowserBridge extends Context.Service<
  BrowserBridge,
  {
    readonly next: Effect.Effect<BrowserCommand | undefined>;
    readonly complete: (id: string, result: Schema.Json) => Effect.Effect<boolean>;
    readonly execute: (
      method: string,
      params: Schema.Json,
    ) => Effect.Effect<Schema.Json, BrowserError>;
  }
>()("magentic/tools/BrowserBridge") {
  static readonly make: Effect.Effect<BrowserBridge["Service"]> = Effect.gen(function* () {
    const commands = yield* Queue.unbounded<BrowserCommand>();
    const pending = new Map<string, Deferred.Deferred<Schema.Json>>();
    return BrowserBridge.of({
      // Held open until a command arrives, so a browser tool reaches the
      // extension at once and an idle extension costs two requests a minute
      // instead of four a second.
      next: Queue.take(commands).pipe(
        Effect.timeoutOption(HOLD),
        Effect.map(Option.getOrUndefined),
      ),
      complete: (id, result) =>
        Effect.suspend(() => {
          const reply = pending.get(id);
          return reply === undefined ? Effect.succeed(false) : Deferred.succeed(reply, result);
        }),
      execute: Effect.fn("BrowserBridge.execute")(function* (method: string, params: Schema.Json) {
        const id = crypto.randomUUID();
        const reply = yield* Deferred.make<Schema.Json>();
        pending.set(id, reply);
        // Removed however the wait ends, including a tool call interrupted
        // before the extension answers, so a late reply is refused.
        return yield* Queue.offer(commands, { id, method, params }).pipe(
          Effect.andThen(Deferred.await(reply)),
          Effect.timeoutOrElse({
            duration: REPLY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new BrowserError({
                  reason: "Timeout",
                  message: "the Helium extension did not answer within 30 seconds",
                }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      }),
    });
  });
}

const Result = Schema.Json;

const browserTool = <Name extends string, Parameters extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  capability: "browser:control" | "browser:script" = "browser:control",
) =>
  Tool.make(name, {
    description,
    parameters,
    success: Result,
    failure: BrowserError,
    failureMode: "return",
  }).annotate(CapabilityAnnotation, capability);

export const BrowserTabs = browserTool(
  "browser_tabs",
  "List tabs in the user's normally launched Helium browser. Select a tab before controlling it.",
  Schema.Struct({
    windowId: Schema.optionalKey(
      Schema.Int.annotate({
        description: "Only the tabs of this window; every window's tabs when omitted",
      }),
    ),
  }),
).annotate(Tool.Readonly, true);

export const BrowserSelectTab = browserTool(
  "browser_select_tab",
  "Select one Helium tab for subsequent browser actions.",
  Schema.Struct({ tabId: Schema.Int }),
);

export const BrowserSnapshot = browserTool(
  "browser_snapshot",
  "Read the selected tab as a compact accessibility tree. Use the returned ref values with browser_click and browser_type.",
  Schema.Struct({ full: Schema.optionalKey(Schema.Boolean) }),
).annotate(Tool.Readonly, true);

export const BrowserNavigate = browserTool(
  "browser_navigate",
  "Navigate the selected Helium tab to a URL, then inspect it with browser_snapshot.",
  Schema.Struct({ url: Schema.NonEmptyString }),
);

export const BrowserClick = browserTool(
  "browser_click",
  "Click an element in the selected tab by a ref from browser_snapshot.",
  Schema.Struct({ ref: Schema.NonEmptyString }),
);

export const BrowserType = browserTool(
  "browser_type",
  "Focus an element in the selected tab by ref and replace its text.",
  Schema.Struct({ ref: Schema.NonEmptyString, text: Schema.String }),
);

export const BrowserPress = browserTool(
  "browser_press",
  "Send a keyboard key to the selected Helium tab, such as Enter, Tab, Escape, or ArrowDown.",
  Schema.Struct({ key: Schema.NonEmptyString }),
);

export const BrowserScroll = browserTool(
  "browser_scroll",
  "Scroll the selected tab up or down.",
  Schema.Struct({ direction: Schema.Literals(["up", "down"]) }),
);

export const BrowserEvaluate = browserTool(
  "browser_evaluate",
  "Run JavaScript in the selected tab. Use only when semantic browser tools cannot do the task.",
  Schema.Struct({ expression: Schema.NonEmptyString }),
  "browser:script",
);

export const BrowserTools = Toolkit.make(
  BrowserTabs,
  BrowserSelectTab,
  BrowserSnapshot,
  BrowserNavigate,
  BrowserClick,
  BrowserType,
  BrowserPress,
  BrowserScroll,
  BrowserEvaluate,
);

export const browserHandlers = Effect.gen(function* () {
  const bridge = yield* BrowserBridge;
  return {
    browser_tabs: (params: typeof BrowserTabs.parametersSchema.Type) =>
      bridge.execute("tabs", params),
    browser_select_tab: (params: typeof BrowserSelectTab.parametersSchema.Type) =>
      bridge.execute("selectTab", params),
    browser_snapshot: (params: typeof BrowserSnapshot.parametersSchema.Type) =>
      bridge.execute("snapshot", params),
    browser_navigate: (params: typeof BrowserNavigate.parametersSchema.Type) =>
      bridge.execute("navigate", params),
    browser_click: (params: typeof BrowserClick.parametersSchema.Type) =>
      bridge.execute("click", params),
    browser_type: (params: typeof BrowserType.parametersSchema.Type) =>
      bridge.execute("type", params),
    browser_press: (params: typeof BrowserPress.parametersSchema.Type) =>
      bridge.execute("press", params),
    browser_scroll: (params: typeof BrowserScroll.parametersSchema.Type) =>
      bridge.execute("scroll", params),
    browser_evaluate: (params: typeof BrowserEvaluate.parametersSchema.Type) =>
      bridge.execute("evaluate", params),
  };
});
