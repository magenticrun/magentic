import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CODEX_API_URL, CODEX_CLIENT_VERSION } from "./Constants.ts";
import type { CodexAuth } from "./CodexAuth.ts";
import { withCodexAuth } from "./CodexClient.ts";

/**
 * One entry of the backend's model list, trimmed to what a picker reads. The
 * response also carries each model's prompts and tool modes, half a megabyte
 * in all, which decoding drops.
 */
export class CodexModel extends Schema.Class<CodexModel>("magentic/model/CodexModel")({
  slug: Schema.String,
  display_name: Schema.String,
  /** "list" for what Codex's picker shows; "hide" for internal models such as its reviewer. */
  visibility: Schema.String,
  /** The window the subscription serves, which can be smaller than the API's. */
  context_window: Schema.optional(Schema.Finite),
  supported_reasoning_levels: Schema.optional(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
  /** Codex's picker order, lowest first. */
  priority: Schema.optional(Schema.Finite),
}) {}

const ModelsResponse = Schema.Struct({ models: Schema.Array(CodexModel) });

export class CodexModelsError extends Schema.TaggedError<CodexModelsError>()("CodexModelsError", {
  message: Schema.String,
}) {}

/**
 * The Codex version the backend is told this client matches. It hides models
 * whose minimum client version is newer, so a model released after the
 * default here appears once this is raised.
 */
export const codexClientVersion = Config.String("MAGENTIC_CODEX_CLIENT_VERSION").pipe(
  Config.withDefault(CODEX_CLIENT_VERSION),
);

/**
 * The models the signed-in account can pick, in Codex's order, from the
 * backend's own list: what the plan serves, not what the public API sells.
 */
export const fetchCodexModels = Effect.fn("CodexModels.fetch")(
  function* (auth: CodexAuth["Service"]) {
    const version = yield* codexClientVersion;
    const http = yield* HttpClient.HttpClient;
    const client = http.pipe(withCodexAuth(auth, crypto.randomUUID()), HttpClient.filterStatusOk);
    const response = yield* client.get(`${CODEX_API_URL}/models`, {
      urlParams: { client_version: version },
    });
    const { models } = yield* HttpClientResponse.schemaBodyJson(ModelsResponse)(response);
    return models
      .filter((model) => model.visibility === "list")
      .toSorted(
        (a, b) =>
          (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY),
      );
  },
  Effect.mapError((error) => new CodexModelsError({ message: error.message })),
);
