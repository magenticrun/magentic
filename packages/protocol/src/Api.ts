import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { AgentInfo, AgentNotFound } from "./Agent.ts";

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
  )
  .prefix("/agents")
  .annotateMerge(OpenApi.annotations({ title: "Agents" })) {}

export class Api extends HttpApi.make("magentic")
  .add(SystemApi)
  .add(AgentsApi)
  .annotateMerge(OpenApi.annotations({ title: "magentic gateway" })) {}
