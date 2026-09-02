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
| `packages/plugin`         | The plugin contract: `define`, the tool, model, agent, command, and event domains.   |
| `packages/model`          | Model provider plugins (OpenAI, Anthropic, Codex, Z.AI, OpenCode Zen) and stores.    |
| `packages/tools`          | The built-in file and shell tools, confined to the workspace.                        |
| `packages/policy`         | The one policy every request passes through.                                         |
| `packages/identity`       | Resolves callers to principals via Slack, Okta, or a local fallback.                 |
| `packages/audit`          | Append-only record of every action.                                                  |
| `packages/surface-slack`  | Slack surface.                                                                       |
| `packages/mcp`            | The `mcp` plugin: tools from MCP servers named in `magentic.yaml`.                   |
| `packages/surface-cursor` | Cursor surface, via MCP.                                                             |

## Develop

```sh
bun install
bun run dev          # gateway with reload on http://localhost:4321
bun run check        # typecheck + lint + knip + tests
```

The gateway listens on 127.0.0.1; set `MAGENTIC_HOST` to bind elsewhere (see `docs/identity.md`).

### Environment

Every setting is an environment variable, read through `Config`. Bun loads a `.env` in the
working directory on its own.

| Variable                   | Default                              | What it does                                                          |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `PORT`                     | `4321`                               | Port the gateway listens on.                                          |
| `MAGENTIC_HOST`            | `127.0.0.1`                          | Address the gateway binds. Anything else needs `IDENTITY_LOCAL=true`. |
| `IDENTITY_LOCAL`           | `false`                              | Accept that local identity trusts every caller on the bound network.  |
| `MAGENTIC_HOME`            | `./magentic`                         | Configuration directory: `magentic.yaml`, `agents/`, plugins.         |
| `MAGENTIC_DATA_DIR`        | `$HOME/.config/magentic`             | Per-person state: conversations, the CLI's last chat.                 |
| `MAGENTIC_WORKSPACE`       | the working directory                | Directory the file and shell tools may touch.                         |
| `MAGENTIC_API_KEYS_FILE`   | `$MAGENTIC_DATA_DIR/api-keys.json`   | Where API keys are kept, mode 0600.                                   |
| `MAGENTIC_CODEX_AUTH_FILE` | `$MAGENTIC_DATA_DIR/codex-auth.json` | Where the ChatGPT (Codex) login is kept, mode 0600.                   |
| `CODEX_HOME`               | `$HOME/.codex`                       | The Codex CLI's directory, for `auth login` to copy its `auth.json`.  |
| `MAGENTIC_MODELS_URL`      | `https://models.dev/api.json`        | Where the model catalog is fetched from.                              |
| `MAGENTIC_MODELS_CACHE`    | `$HOME/.cache/magentic/models.json`  | The catalog's on-disk copy, refreshed hourly.                         |
| `MAGENTIC_MODELS_OFFLINE`  | `false`                              | Never fetch the catalog; use the cache or the bundled snapshot.       |
| `USER`                     | `local`                              | The subject local identity resolves every caller to.                  |

In another terminal:

```sh
bun apps/cli/src/main.ts agents
bun apps/cli/src/main.ts --gateway http://gateway.internal:4321 agents
```

## License

MIT
