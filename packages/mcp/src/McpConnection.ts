import { messageOf } from "@magentic/plugin";
import {
  type CallToolResult,
  Client,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  type Tool as McpToolDefinition,
  type Transport,
  UnauthorizedError,
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

/** A way to reach the server, and what to call it when it fails. */
interface Candidate {
  readonly name: string;
  readonly transport: Transport;
}

/** One transport's failure to connect; `refused` is the status when the server said 401 or 403. */
class AttemptFailed extends Schema.TaggedError<AttemptFailed>()("AttemptFailed", {
  transport: Schema.String,
  message: Schema.String,
  refused: Schema.optional(Schema.Literals([401, 403])),
}) {}

const refusal = (status: number | undefined) =>
  status === 401 || status === 403 ? status : undefined;

/**
 * The status when the server turned the client away rather than failing to
 * answer: the SDK's own unauthorized error, or an HTTP error carrying 401 or 403.
 */
const refusedWith = (cause: unknown): 401 | 403 | undefined => {
  if (UnauthorizedError.isInstance(cause)) {
    return 401;
  }
  if (SdkHttpError.isInstance(cause)) {
    return refusal(cause.status);
  }
  return SseError.isInstance(cause) ? refusal(cause.code) : undefined;
};

/**
 * The one error a server that could not be reached reports. A refusal wins
 * over whatever the other transport said: a server that answers the
 * Streamable HTTP handshake with 401 usually answers the SSE fallback with
 * something beside the point, such as 404 or 405, and reporting that would
 * send a person looking in the wrong place. Otherwise every transport's
 * error is kept, each under its name.
 */
const describeFailures = (failures: ReadonlyArray<AttemptFailed>): string => {
  const refused = failures.find((failure) => failure.refused !== undefined);
  if (refused !== undefined) {
    return `the server refused the connection over ${refused.transport} (HTTP ${refused.refused}): ${refused.message}; check the credentials in the entry's headers`;
  }
  const [first, ...rest] = failures;
  if (first === undefined) {
    return "no transport to try";
  }
  return rest.length === 0
    ? first.message
    : failures.map((failure) => `${failure.transport}: ${failure.message}`).join("; ");
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
    const candidate: Candidate = { name: "stdio", transport: stdio };
    return [candidate];
  }
  const url = yield* Effect.try({
    try: () => new URL(config.url),
    catch: () => `${config.url} is not a URL`,
  });
  const headers = config.headers;
  const options = headers === undefined ? {} : { requestInit: { headers } };
  const streamable: Candidate = {
    name: "Streamable HTTP",
    transport: new StreamableHTTPClientTransport(url, options),
  };
  const sse: Candidate = { name: "SSE", transport: new SSEClientTransport(url, options) };
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
  const attempt = Effect.fn("Mcp.attempt")(function* ({ name, transport }: Candidate) {
    const client = new Client(
      { name: "magentic", version: "0.0.0" },
      { capabilities: { roots: {} } },
    );
    attach(client);
    const connected = yield* Effect.tryPromise({
      try: (signal) => client.connect(transport, { signal, timeout }),
      catch: (cause) =>
        new AttemptFailed({
          transport: name,
          message: messageOf(cause),
          refused: refusedWith(cause),
        }),
    }).pipe(Effect.timeoutOption(Duration.millis(timeout)));
    if (Option.isNone(connected)) {
      yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore);
      return yield* new AttemptFailed({
        transport: name,
        message: `no answer after ${timeout}ms`,
      });
    }
    return client;
  });

  /** The first transport that completes the handshake; every failure when none does. */
  const connectAny = Effect.gen(function* () {
    const failures: Array<AttemptFailed> = [];
    for (const candidate of transports) {
      const outcome = yield* Effect.result(attempt(candidate));
      if (outcome._tag === "Success") {
        return outcome.success;
      }
      failures.push(outcome.failure);
    }
    return yield* failed(describeFailures(failures));
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
