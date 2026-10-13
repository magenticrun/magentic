import { CapabilityAnnotation } from "@magentic/plugin";
import type { CallToolResult, Tool as McpToolDefinition } from "@modelcontextprotocol/client";
import { Effect, Option, Predicate, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { createHash } from "node:crypto";
import { type McpConnection, ToolArguments } from "./McpConnection.ts";

/** What the model sees when a server's tool fails or the server is gone. */
export class McpToolError extends Schema.TaggedError<McpToolError>()("McpToolError", {
  server: Schema.String,
  tool: Schema.String,
  message: Schema.String,
}) {}

/** Anything a model might not be allowed to send back becomes `_`. */
export const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The longest tool name OpenAI accepts (`^[a-zA-Z0-9_-]{1,64}$`); Anthropic allows the same. */
const NAME_LIMIT = 64;

/**
 * A sanitized name cut to `NAME_LIMIT`: a longer one keeps its start and
 * ends in `_` and eight hex characters of its whole's hash, so two long names
 * that share a start still come out apart, and the same name always comes
 * out the same, turn after turn, which a replayed tool call relies on.
 */
const fitName = (name: string): string => {
  if (name.length <= NAME_LIMIT) {
    return name;
  }
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, NAME_LIMIT - hash.length - 1)}_${hash}`;
};

/**
 * `<server>_<tool>`, so a tool's name says where it runs and two servers
 * cannot clash, cut to what the providers accept.
 */
export const toolName = (server: string, tool: string): string =>
  fitName(`${sanitize(server)}_${sanitize(tool)}`);

const decodeArguments = Schema.decodeUnknownOption(ToolArguments);
const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/** A block of a tool result as JSON. Binary payloads are described, not copied. */
const describeBlock = (block: CallToolResult["content"][number]): Schema.Json => {
  switch (block.type) {
    case "text":
      return capText(block.text);
    case "image":
    case "audio":
      return {
        type: block.type,
        mimeType: block.mimeType,
        omitted: `${block.data.length} base64 chars`,
      };
    case "resource":
      return "text" in block.resource
        ? { type: "resource", uri: block.resource.uri, text: capText(block.resource.text) }
        : { type: "resource", uri: block.resource.uri, omitted: "binary contents" };
    case "resource_link":
      return { type: "resource_link", uri: block.uri, name: block.name };
  }
};

/**
 * Characters of a result the model gets back, the same as `OUTPUT_LIMIT` in
 * `@magentic/tools` for our own tools' output; this package does not depend
 * on that one, so the number is repeated rather than imported.
 */
const OUTPUT_LIMIT = 30_000;
const HALF = Math.floor(OUTPUT_LIMIT / 2);

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Text past `OUTPUT_LIMIT` keeps its first and last halves and says how much
 * went between, the way a long command's output does. Neither cut lands
 * between the two halves of a surrogate pair, which would leave a lone half
 * that no provider can encode.
 */
const capText = (text: string): string => {
  if (text.length <= OUTPUT_LIMIT) {
    return text;
  }
  const headEnd = isHighSurrogate(text.charCodeAt(HALF - 1)) ? HALF - 1 : HALF;
  const tailStart = isLowSurrogate(text.charCodeAt(text.length - HALF))
    ? text.length - HALF + 1
    : text.length - HALF;
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n\n[${omitted} characters omitted]\n\n${text.slice(tailStart)}`;
};

const textOf = (content: CallToolResult["content"]): string =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .filter((text) => text.trim() !== "")
    .join("\n\n");

/**
 * Structured content as it is, or as capped JSON text when it would run past
 * `OUTPUT_LIMIT`: the model reads it as text either way.
 */
const capJson = (json: Schema.Json): Schema.Json => {
  const text = JSON.stringify(json);
  return text.length <= OUTPUT_LIMIT ? json : capText(text);
};

/**
 * The value the model receives: the text when the result is only text, the
 * structured content when there is nothing else, otherwise every block. Text
 * is capped at `OUTPUT_LIMIT` wherever it appears.
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
      message: message === "" ? "the tool reported an error" : capText(message),
    });
  }
  if (result.content.every((block) => block.type === "text")) {
    const text = textOf(result.content);
    if (text !== "" || result.structuredContent === undefined) {
      return Effect.succeed(capText(text));
    }
    return Effect.succeed(
      capJson(Option.getOrElse(decodeJson(result.structuredContent), () => "")),
    );
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
 * `Schema.Unknown`, and neither provider can derive a codec from that when a
 * call comes back: each wants an object at the root, so every call to the
 * tool failed. The model still sees the server's schema, which
 * `Tool.getJsonSchema` prefers over the decoder; only the decoder changes.
 * The server wrote its schema for its own validator and gets the arguments
 * exactly as the model sent them, so the decoder only asks for a JSON
 * object. It is `Schema.Any` with a check rather than a struct or a record
 * because the providers rewrite those on their way to a codec: a record
 * becomes an array of entries, a struct with no properties a union with
 * array, and both are refused at the root. A check on `Any` passes through
 * untouched, and its `toJsonSchema` is what makes the root an object.
 */
const JsonObject = Schema.Any.check(
  Schema.makeFilter((input) => Predicate.isObject(input) && !Array.isArray(input), {
    expected: "a JSON object",
    toJsonSchema: () => ({ type: "object" }),
  }),
);

const withArgumentsDecoder = <T extends Tool.Any>(tool: T, decoder: Schema.Top): T =>
  // SAFETY: a clone with the prototype and every field of `tool`; the one field replaced is a
  // schema of the same kind, and the handler already reads its decoded value as an object.
  Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
    parametersSchema: decoder,
  }) as T;

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Keywords that bring properties in from elsewhere, so `required` may name ones not listed here. */
const COMPOSING = ["allOf", "anyOf", "oneOf", "$ref", "patternProperties"];

/** Keywords whose value is one subschema, and those whose value is a list or map of them. */
const SUBSCHEMA = new Set(["items", "additionalProperties", "not"]);
const SUBSCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SUBSCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);

const mapValues = (
  object: Schema.JsonObject,
  f: (value: Schema.Json) => Schema.Json,
): Schema.JsonObject =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, f(value)]));

/** One keyword's value with its subschemas walked; anything else is data and stays as written. */
const walkKeyword = (key: string, value: Schema.Json): Schema.Json => {
  if (SUBSCHEMA.has(key)) {
    return pruneRequired(value);
  }
  if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) {
    return value.map(pruneRequired);
  }
  if (SUBSCHEMA_MAPS.has(key) && isJsonObject(value)) {
    return mapValues(value, pruneRequired);
  }
  return value;
};

/**
 * One object schema with its `required` cut to the properties it declares,
 * and every subschema under it the same. A schema that composes others is
 * left alone, since what it requires may be declared in one of them. Only
 * schema positions are walked, so a `default` or `enum` value that happens
 * to hold a `required` key is data and stays as written.
 */
const pruneRequired = (schema: Schema.Json): Schema.Json => {
  if (!isJsonObject(schema)) {
    return schema;
  }
  const walked = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, walkKeyword(key, value)]),
  );
  const required = schema["required"];
  if (!Array.isArray(required) || COMPOSING.some((key) => key in schema)) {
    return walked;
  }
  const properties = schema["properties"];
  const declared = isJsonObject(properties) ? properties : {};
  const kept = required.filter((name) => Predicate.isString(name) && Object.hasOwn(declared, name));
  if (kept.length === required.length) {
    return walked;
  }
  const { required: _dropped, ...rest } = walked;
  return kept.length === 0 ? rest : { ...rest, required: kept };
};

/**
 * The server's input schema as the providers will take it. MCP says the
 * root is an object schema, but servers leave out `properties` when a tool
 * takes nothing, and list in `required` names they never declared; either
 * gets a tool refused by a strict validator on the provider's side, and
 * with it the whole request. The root is made an object with properties,
 * and `required` keeps only what is declared, at every level. Nothing is
 * added beyond that: `additionalProperties: false` would only matter to
 * strict mode, which is off for these tools, and would refuse arguments a
 * server's own validator accepts.
 */
const inputSchemaOf = (definition: McpToolDefinition): Schema.JsonObject => {
  const decoded = Option.getOrUndefined(decodeJson(definition.inputSchema));
  const root = pruneRequired(isJsonObject(decoded) ? decoded : {});
  const schema = isJsonObject(root) ? root : {};
  const properties = schema["properties"];
  return {
    ...schema,
    type: "object",
    properties: isJsonObject(properties) ? properties : {},
  };
};

const makeTool = (name: string, definition: McpToolDefinition) =>
  annotate(
    withArgumentsDecoder(
      Tool.dynamic(name, {
        description: definition.description ?? definition.title ?? definition.name,
        parameters: inputSchemaOf(definition),
        success: Schema.Json,
        failure: McpToolError,
        failureMode: "return",
      })
        .annotate(CapabilityAnnotation, "mcp")
        // The server wrote the schema for its own validator, not for OpenAI's strict
        // mode, which rejects any optional property; the server checks the arguments.
        .annotate(Tool.Strict, false),
      JsonObject,
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
      // The suffix goes on the whole name, then the whole is cut again: a long name keeps its
      // number inside the limit, and its hash changes with it.
      name = fitName(`${sanitize(connection.server)}_${sanitize(definition.name)}_${n}`);
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
