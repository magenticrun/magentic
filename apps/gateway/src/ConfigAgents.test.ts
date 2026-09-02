import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { AgentRegistry, builtin, PluginHost, ToolCallGuard } from "@magentic/core";
import { ModelCatalog } from "@magentic/plugin";
import { Effect, FileSystem, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { configAgentsPlugin } from "./ConfigAgents.ts";

/** A config directory with one good agent, one using a prompt file, and one broken file. */
const HostLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "magentic-config-" });
    yield* fs.makeDirectory(`${dir}/agents`);
    yield* fs.makeDirectory(`${dir}/prompts`);
    yield* fs.writeFileString(
      `${dir}/agents/deploy-bot.yaml`,
      [
        "name: deploy-bot",
        "description: Ships services.",
        "model: anthropic",
        "prompt: You ship things.",
        "tools: [read_file]",
      ].join("\n"),
    );
    yield* fs.writeFileString(`${dir}/prompts/reviewer.md`, "You review code.\n");
    yield* fs.writeFileString(
      `${dir}/agents/reviewer.yml`,
      ["name: reviewer", "prompt:", "  file: prompts/reviewer.md"].join("\n"),
    );
    yield* fs.writeFileString(`${dir}/agents/broken.yaml`, "description: no name here\n");
    yield* fs.writeFileString(`${dir}/agents/notes.txt`, "not an agent\n");
    return PluginHost.layer({
      plugins: [builtin(configAgentsPlugin({ dir, watch: false }))],
      paths: { config: dir, workspace: dir, data: dir },
    });
  }),
).pipe(
  Layer.provide(ToolCallGuard.layerAllowAll),
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ModelCatalog.layerSnapshot),
  ),
);

layer(HostLayer)("configAgentsPlugin", (it) => {
  it.effect("loads every agent file that decodes and skips the rest", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const agents = yield* registry.list;
      assert.deepStrictEqual(
        agents.map((a) => a.name),
        ["deploy-bot", "reviewer"],
      );
      const deploy = yield* registry.get("deploy-bot");
      assert.strictEqual(deploy.model, "anthropic");
      assert.deepStrictEqual([...deploy.tools], ["read_file"]);
      const reviewer = yield* registry.get("reviewer");
      assert.strictEqual(reviewer.prompt, "You review code.\n");
      assert.strictEqual(reviewer.model, undefined);
      assert.deepStrictEqual([...reviewer.tools], []);

      const plugins = yield* (yield* PluginHost).plugins;
      assert.deepStrictEqual([...(plugins[0]?.agents ?? [])], ["deploy-bot", "reviewer"]);
      assert.strictEqual(Option.fromNullishOr(plugins[0]?.error)._tag, "None");
    }),
  );
});
