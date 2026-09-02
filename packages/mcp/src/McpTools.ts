import { CapabilityAnnotation } from "@magentic/plugin";
import type { CallToolResult, Tool as McpToolDefinition } from "@modelcontextprotocol/client";
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { type McpConnection, ToolArguments } from "./McpConnection.ts";

/** What the model sees when a server's tool fails or the server is gone. */
export class McpToolError extends Schema.TaggedError<McpToolError>()("McpToolError", {
  server: Schema.String,
  tool: Schema.String,
  message: Schema.String,
}) {}

/** Anything a model might not be allowed to send back becomes `_`. */
export const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** `<server>_<tool>`, so a tool's name says where it runs and two servers cannot clash. */
export const toolName = (server: string, tool: string): string =>
  `${sanitize(server)}_${sanitize(tool)}`;

const decodeArguments = Schema.decodeUnknownOption(ToolArguments);
const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/** A block of a tool result as JSON. Binary payloads are described, not copied. */
const describeBlock = (block: CallToolResult["content"][number]): Schema.Json => {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
    case "audio":
      return {
        type: block.type,
        mimeType: block.mimeType,
        omitted: `${block.data.length} base64 chars`,
      };
    case "resource":
      return "text" in block.resource
        ? { type: "resource", uri: block.resource.uri, text: block.resource.text }
        : { type: "resource", uri: block.resource.uri, omitted: "binary contents" };
    case "resource_link":
      return { type: "resource_link", uri: block.uri, name: block.name };
  }
};

const textOf = (content: CallToolResult["content"]): string =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .filter((text) => text.trim() !== "")
    .join("\n\n");

/**
 * The value the model receives: the text when the result is only text, the
 * structured content when there is nothing else, otherwise every block.
 */
const fromResult = (
  server: string,
  tool: string,
  result: CallToolResult,
): Effect.Effect<Schema.Json, McpToolError> => {
  if (result.isError === true) {
    const message = textOf(result.content);
    return new McpToolError({
      server,
      tool,
      message: message === "" ? "the tool reported an error" : message,
    });
  }
  if (result.content.every((block) => block.type === "text")) {
    const text = textOf(result.content);
    if (text !== "" || result.structuredContent === undefined) {
      return Effect.succeed(text);
    }
    return Effect.succeed(Option.getOrElse(decodeJson(result.structuredContent), () => ""));
  }
  return Effect.succeed(result.content.map(describeBlock));
};

/** MCP's hints, carried as Effect's annotations for surfaces that show them. */
const annotate = <T extends Tool.Any>(tool: T, definition: McpToolDefinition): T => {
  const hints = definition.annotations;
  if (hints === undefined) {
    return tool;
  }
  const flags = [
    [Tool.Readonly, hints.readOnlyHint],
    [Tool.Destructive, hints.destructiveHint],
    [Tool.Idempotent, hints.idempotentHint],
    [Tool.OpenWorld, hints.openWorldHint],
  ] as const;
  let annotated = tool;
  for (const [flag, value] of flags) {
    if (value !== undefined) {
      // SAFETY: `annotate` returns the same tool with one more annotation; the shape is unchanged.
      annotated = annotated.annotate(flag, value) as T;
    }
  }
  return annotated;
};

/**
 * A dynamic tool built from a JSON Schema decodes its arguments with
 * `Schema.Unknown`, and the OpenAI provider cannot derive a codec from that
 * when a call comes back: it wants an object at the root, so every call to
 * the tool failed. The model still sees the server's schema, which
 * `Tool.getJsonSchema` prefers over the decoder; only the decoder changes, to
 * one that takes any object, which is all the server's validator gets anyway.
 */
const withObjectArguments = <T extends Tool.Any>(tool: T): T =>
  // SAFETY: a clone with the prototype and every field of `tool`; the one field replaced is a
  // schema of the same kind, and the handler already reads its decoded value as an object.
  Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
    parametersSchema: ToolArguments,
  }) as T;

const makeTool = (name: string, definition: McpToolDefinition) =>
  annotate(
    withObjectArguments(
      Tool.dynamic(name, {
        description: definition.description ?? definition.title ?? definition.name,
        parameters: definition.inputSchema,
        success: Schema.Json,
        failure: McpToolError,
        failureMode: "return",
      })
        .annotate(CapabilityAnnotation, "mcp")
        // The server wrote the schema for its own validator, not for OpenAI's strict
        // mode, which rejects any optional property; the server checks the arguments.
        .annotate(Tool.Strict, false),
    ),
    definition,
  );

export type McpTool = ReturnType<typeof makeTool>;

/**
 * The server's tools as one toolkit with handlers. A call forwards the
 * model's arguments as they are: the server validates them against the
 * schema it published, and its answer comes back as a tool result either way.
 * Two tools whose names sanitize to the same string get a numbered suffix,
 * logged, rather than one silently replacing the other.
 */
export const toolkitFor = Effect.fn("Mcp.toolkitFor")(function* (
  connection: McpConnection,
  definitions: ReadonlyArray<McpToolDefinition>,
) {
  const tools: Array<McpTool> = [];
  const handlers: Record<
    string,
    (params: McpTool["parametersSchema"]["Type"]) => Effect.Effect<Schema.Json, McpToolError>
  > = {};
  const used = new Set<string>();
  for (const definition of definitions) {
    const wanted = toolName(connection.server, definition.name);
    let name = wanted;
    for (let n = 2; used.has(name); n++) {
      name = `${wanted}_${n}`;
    }
    if (name !== wanted) {
      yield* Effect.logWarning(
        `mcp server ${connection.server}: tool ${definition.name} is registered as ${name}, since ${wanted} is taken by another of its tools`,
      );
    }
    used.add(name);
    const tool = makeTool(name, definition);
    tools.push(tool);
    handlers[tool.name] = Effect.fn(`Mcp.${tool.name}`)(function* (params) {
      const args = Option.getOrElse(decodeArguments(params), (): ToolArguments => ({}));
      const result = yield* connection.callTool(definition.name, args).pipe(
        Effect.mapError(
          (error) =>
            new McpToolError({
              server: connection.server,
              tool: definition.name,
              message: error.message,
            }),
        ),
      );
      return yield* fromResult(connection.server, definition.name, result);
    });
  }
  const toolkit = Toolkit.make(...tools);
  const context = yield* toolkit.toHandlers(handlers);
  return yield* toolkit.pipe(Effect.provideContext(context));
});
