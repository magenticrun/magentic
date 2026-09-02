# magentic

**The agent harness your team can actually share.**

magentic is an open-source agent harness built for teams instead of one person. Run it as a gateway on your own box and it becomes the shared brain: your agents live there, with skills, tools, memory, and cron; people reach them from Slack, a terminal, or Cursor; and every request passes through one policy that knows who's asking, what they may use, and what needs approval. Identity comes from Slack, or Okta when you have it, and every action is audited.

Locally it's just a good agent. Deployed, it's the one your whole team can safely share.

## Layout

A [Bun](https://bun.sh) workspace built on [Effect](https://effect.website) 4.

| Package                   | Role                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `apps/gateway`            | The server. Hosts agents and runs every request through identity, policy, and audit. |
| `apps/cli`                | Terminal client (`magentic`).                                                        |
| `packages/protocol`       | Wire schemas and the RPC definition shared by the gateway and every surface.         |
| `packages/core`           | Agent runtime: agents, skills, tools, memory, cron.                                  |
| `packages/policy`         | The one policy every request passes through.                                         |
| `packages/identity`       | Resolves callers to principals via Slack, Okta, or a local fallback.                 |
| `packages/audit`          | Append-only record of every action.                                                  |
| `packages/surface-slack`  | Slack surface.                                                                       |
| `packages/surface-cursor` | Cursor surface, via MCP.                                                             |

## Develop

```sh
bun install
bun run dev          # gateway with reload on http://localhost:4321
bun run check        # typecheck + lint + tests
```

In another terminal:

```sh
bun apps/cli/src/main.ts agents
bun apps/cli/src/main.ts --gateway http://gateway.internal:4321 agents
```

## License

MIT
