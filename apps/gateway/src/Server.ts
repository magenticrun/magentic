import { BunHttpServer } from "@effect/platform-bun";
import { Api } from "@magentic/protocol";
import { Config, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { AgentsApiHandlers, SystemApiHandlers } from "./Handlers.ts";

export const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([SystemApiHandlers, AgentsApiHandlers]),
);

export const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

export const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute);

/** The whole gateway as one layer. `Layer.launch` it to run. */
export const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.port("PORT").pipe(Config.withDefault(4321)),
    }),
  ),
);
