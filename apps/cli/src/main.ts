#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Api } from "@magentic/protocol";
import { Console, Effect, flow } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const gateway = Flag.string("gateway").pipe(
  Flag.withAlias("g"),
  Flag.withDescription("Base URL of the gateway"),
  Flag.withDefault("http://localhost:4321"),
);

const magentic = Command.make("magentic").pipe(
  Command.withSharedFlags({ gateway }),
  Command.withDescription("Talk to a magentic gateway from the terminal"),
);

const makeClient = (baseUrl: string) =>
  HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(baseUrl))),
  });

const agents = Command.make(
  "agents",
  {},
  Effect.fn(function* () {
    const root = yield* magentic;
    const client = yield* makeClient(root.gateway);
    const list = yield* client.agents.list();
    if (list.length === 0) {
      return yield* Console.log("no agents registered");
    }
    for (const agent of list) {
      yield* Console.log(`${agent.name}\t${agent.description}`);
    }
  }),
).pipe(Command.withDescription("List agents hosted by the gateway"));

magentic.pipe(
  Command.withSubcommands([agents]),
  Command.run({ version: "0.0.0" }),
  Effect.provide([BunServices.layer, FetchHttpClient.layer]),
  BunRuntime.runMain,
);
