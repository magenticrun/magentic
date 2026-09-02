import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { AgentInfo, AgentNotFound } from "./Agent.ts";
import { PluginInfo } from "./Plugin.ts";
import { RunDenied, RunEvent, RunRequest } from "./Run.ts";

// The API definition lives here, apart from the gateway, so surfaces can derive
// typed clients from it without pulling in server code.

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
) {}

export class AgentsApi extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(AgentInfo) }),
    HttpApiEndpoint.get("get", "/:name", {
      params: { name: Schema.String },
      success: AgentInfo,
      error: AgentNotFound,
    }),
    HttpApiEndpoint.post("run", "/:name/runs", {
      params: { name: Schema.String },
      payload: RunRequest,
      success: HttpApiSchema.StreamSse({ data: RunEvent }),
      error: [AgentNotFound, RunDenied],
    }),
  )
  .prefix("/agents")
  .annotateMerge(OpenApi.annotations({ title: "Agents" })) {}

export class PluginsApi extends HttpApiGroup.make("plugins")
  .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(PluginInfo) }))
  .prefix("/plugins")
  .annotateMerge(OpenApi.annotations({ title: "Plugins" })) {}

export class Api extends HttpApi.make("magentic")
  .add(SystemApi)
  .add(AgentsApi)
  .add(PluginsApi)
  .annotateMerge(OpenApi.annotations({ title: "magentic gateway" })) {}
