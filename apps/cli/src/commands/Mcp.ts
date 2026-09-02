import { type CommandInput, CommandError, define } from "@magentic/plugin";
import type { McpServerInfo } from "@magentic/protocol";
import { Effect } from "effect";

const NAME = "mcp";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `connected, 12 tools`, `failed`, `disabled`: the standing at a glance. */
const standing = (server: McpServerInfo): string =>
  server.status === "connected"
    ? `connected, ${plural(server.tools.length, "tool")}`
    : server.status;

/** One server, indented: its target, then what went wrong, then every tool when asked. */
const detail = (server: McpServerInfo, withTools: boolean): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (server.target !== undefined) {
    lines.push(`  ${server.target}`);
  }
  if (server.error !== undefined) {
    lines.push(`  ${server.error}`);
  }
  if (withTools && server.tools.length > 0) {
    lines.push(...server.tools.map((tool) => `  ${tool}`));
  }
  return lines;
};

/**
 * `/mcp`: every server named under `mcp:` in the gateway's `magentic.yaml`,
 * with whether it connected and, when it did not, why, so a missing tool is
 * explained here rather than in the gateway log. `/mcp <server>` adds the
 * tools one server offers.
 */
const run = Effect.fn("mcp.run")(function* ({ ui, session, args }: CommandInput) {
  const servers = yield* session.mcpServers;
  if (servers.length === 0) {
    return yield* ui.notify("No MCP servers; name them under mcp: in the gateway's magentic.yaml.");
  }
  const width = Math.max(...servers.map((server) => server.name.length));
  if (args.length > 0) {
    const server = servers.find((s) => s.name === args);
    if (server === undefined) {
      return yield* new CommandError({
        command: NAME,
        message: `No MCP server ${args}; servers: ${servers.map((s) => s.name).join(", ")}`,
      });
    }
    return yield* ui.notify(
      [`${server.name}  ${standing(server)}`, ...detail(server, true)].join("\n"),
    );
  }
  const lines = servers.flatMap((server) => [
    `${server.name.padEnd(width)}  ${standing(server)}`,
    ...detail(server, false),
  ]);
  yield* ui.notify(
    [`MCP servers (${servers.length}); /mcp <server> lists its tools`, ...lines].join("\n"),
  );
});

export const mcpCommandPlugin = define({
  id: "mcp-command",
  description: "The /mcp command: the gateway's MCP servers, connected or not, and why.",
  setup: Effect.fn("mcpCommandPlugin.setup")(function* (ctx) {
    yield* ctx.command.register({
      name: NAME,
      description: "Show the MCP servers and whether each connected: /mcp [server]",
      run,
    });
  }),
});
