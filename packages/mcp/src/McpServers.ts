import type { McpServerInfo } from "@magentic/protocol";
import { Context, Effect, Layer, Ref } from "effect";

/**
 * Where each configured server stands, as the `mcp` plugin last reported
 * it. The plugin writes here as it connects, republishes, and loses servers;
 * the gateway answers `listMcpServers` from it, so a surface can say why a
 * server's tools are missing without reading the gateway log.
 */
export class McpServers extends Context.Service<
  McpServers,
  {
    /** Every server the plugin was given, by name. */
    readonly list: Effect.Effect<ReadonlyArray<McpServerInfo>>;
    /** Replace what is known about one server. */
    report(info: McpServerInfo): Effect.Effect<void>;
  }
>()("magentic/mcp/McpServers") {
  static readonly layer = Layer.effect(
    McpServers,
    Effect.gen(function* () {
      const servers = yield* Ref.make(new Map<string, McpServerInfo>());
      return McpServers.of({
        list: Effect.map(Ref.get(servers), (all) =>
          [...all.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
        ),
        report: (info) => Ref.update(servers, (all) => new Map(all).set(info.name, info)),
      });
    }),
  );
}
