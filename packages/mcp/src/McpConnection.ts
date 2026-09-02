import { messageOf } from "@magentic/plugin";
import {
  type CallToolResult,
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool as McpToolDefinition,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Duration, Effect, Option, Path, Predicate, Queue, Schema } from "effect";
import { pathToFileURL } from "node:url";
import { DEFAULT_TIMEOUT_MS, type McpServerConfig } from "./McpConfig.ts";

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  reason: Schema.Literals(["Connect", "ListTools", "Call"]),
  message: Schema.String,
}) {}

/** What a server tells us after the handshake, in the order it arrives. */
export type ConnectionEvent =
  | { readonly _tag: "ToolsChanged" }
  | { readonly _tag: "Closed" }
  | {
      readonly _tag: "Log";
      readonly level: string;
      readonly logger: Option.Option<string>;
      readonly data: string;
    };

/** Arguments a tool call carries: the JSON object the model produced. */
export const ToolArguments = Schema.Record(Schema.String, Schema.Json);
export type ToolArguments = typeof ToolArguments.Type;

/** One live MCP server. Closes with the scope it was connected in. */
export interface McpConnection {
  readonly server: string;
  /** The server's own guidance for the model, when it sent any. */
  readonly instructions: Option.Option<string>;
  readonly listTools: Effect.Effect<ReadonlyArray<McpToolDefinition>, McpError>;
  callTool(name: string, args: ToolArguments): Effect.Effect<CallToolResult, McpError>;
  readonly events: Queue.Dequeue<ConnectionEvent>;
}

/**
 * A local server's stderr, line by line, as log events. Left to the SDK the
 * child would inherit ours, and a gateway embedded in the full-screen chat
 * would have the server's logs drawn over the transcript.
 */
const forwardStderr = (transport: StdioClientTransport, events: Queue.Enqueue<ConnectionEvent>) => {
  const stderr = transport.stderr;
  if (stderr === null) {
    return;
  }
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (line: string) => {
    if (line.trim().length > 0) {
      Queue.offerUnsafe(events, {
        _tag: "Log",
        level: "info",
        logger: Option.some("stderr"),
        data: line,
      });
    }
  };
  stderr.on("data", (chunk: Uint8Array | string) => {
    pending += Predicate.isString(chunk) ? chunk : decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(emit);
  });
  stderr.on("end", () => {
    emit(pending);
    pending = "";
  });
};

/** Builds the transports to try, in order. Remote servers get SSE as a fallback. */
const transportsFor = Effect.fn("Mcp.transportsFor")(function* (
  config: McpServerConfig,
  workspace: string,
  events: Queue.Enqueue<ConnectionEvent>,
) {
  const path = yield* Path.Path;
  if (config.type === "local") {
    const [command, ...args] = config.command;
    const cwd = config.cwd === undefined ? workspace : path.resolve(workspace, config.cwd);
    const env = { ...getDefaultEnvironment(), ...config.environment };
    const stdio = new StdioClientTransport({ command, args, cwd, env, stderr: "pipe" });
    forwardStderr(stdio, events);
    const transport: Transport = stdio;
    return [transport];
  }
  const url = yield* Effect.try({
    try: () => new URL(config.url),
    catch: () => `${config.url} is not a URL`,
  });
  const headers = config.headers;
  const options = headers === undefined ? {} : { requestInit: { headers } };
  const streamable: Transport = new StreamableHTTPClientTransport(url, options);
  const sse: Transport = new SSEClientTransport(url, options);
  return [streamable, sse];
});

/**
 * Connects to one server, finishes the handshake, and hands back a client
 * that the current scope closes. Events the server sends afterwards land on
 * `events`; the queue is fed from the SDK's callbacks, so nothing here needs
 * a runtime.
 */
export const connect = Effect.fn("Mcp.connect")(function* (
  server: string,
  config: McpServerConfig,
  workspace: string,
) {
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  const events = yield* Queue.unbounded<ConnectionEvent>();
  const failed = (message: string) => new McpError({ server, reason: "Connect", message });
  const transports = yield* transportsFor(config, workspace, events).pipe(Effect.mapError(failed));

  const attach = (client: Client) => {
    client.setRequestHandler("roots/list", () => ({
      roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }],
    }));
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      Queue.offerUnsafe(events, { _tag: "ToolsChanged" });
    });
    client.setNotificationHandler("notifications/message", (notification) => {
      Queue.offerUnsafe(events, {
        _tag: "Log",
        level: notification.params.level,
        logger: Option.fromNullishOr(notification.params.logger),
        data: JSON.stringify(notification.params.data),
      });
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK client exposes a slot, not an event target
    client.onclose = () => {
      Queue.offerUnsafe(events, { _tag: "Closed" });
    };
  };

  /** A fresh client per transport: the SDK does not reconnect one that failed. */
  const attempt = (transport: Transport) =>
    Effect.gen(function* () {
      const client = new Client(
        { name: "magentic", version: "0.0.0" },
        { capabilities: { roots: {} } },
      );
      attach(client);
      const connected = yield* Effect.tryPromise({
        try: (signal) => client.connect(transport, { signal, timeout }),
        catch: (cause) => failed(messageOf(cause)),
      }).pipe(Effect.timeoutOption(Duration.millis(timeout)));
      if (Option.isNone(connected)) {
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore);
        return yield* failed(`no answer after ${timeout}ms`);
      }
      return client;
    });

  /** The first transport that completes the handshake; the last error when none does. */
  const connectAny = Effect.gen(function* () {
    let last = Option.none<McpError>();
    for (const transport of transports) {
      const outcome = yield* Effect.result(attempt(transport));
      if (outcome._tag === "Success") {
        return outcome.success;
      }
      last = Option.some(outcome.failure);
    }
    return yield* Option.getOrElse(last, () => failed("no transport to try"));
  });

  const client = yield* Effect.acquireRelease(connectAny, (c) =>
    Effect.tryPromise(() => c.close()).pipe(Effect.ignore),
  );

  const listTools: McpConnection["listTools"] = Effect.gen(function* () {
    if (client.getServerCapabilities()?.tools === undefined) {
      return [];
    }
    const result = yield* Effect.tryPromise({
      try: (signal) => client.listTools(undefined, { signal, timeout }),
      catch: (cause) => new McpError({ server, reason: "ListTools", message: messageOf(cause) }),
    });
    return result.tools;
  });

  const callTool = (name: string, args: ToolArguments) =>
    Effect.tryPromise({
      try: (signal) =>
        client.callTool(
          { name, arguments: args },
          { signal, timeout, resetTimeoutOnProgress: true, onprogress: () => {} },
        ),
      catch: (cause) => new McpError({ server, reason: "Call", message: messageOf(cause) }),
    });

  const connection: McpConnection = {
    server,
    instructions: Option.fromNullishOr(client.getInstructions()?.trim()).pipe(
      Option.filter((text) => text !== ""),
    ),
    listTools,
    callTool,
    events,
  };
  return connection;
});
