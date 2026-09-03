<p align="center">
  <img src="docs/logotype.svg" width="481" alt="magentic" />
</p>

**The agent harness your team can actually share.**

magentic is a self-hosted, Bun-native agent gateway for a shared workspace. It gives people a terminal interface today and is designed to put the same agents, tools, conversation history, and controls behind other team surfaces.

Run it locally and it is a capable coding agent. Run it as a gateway and one configuration can define the agents your team uses.

> **Current status:** early-stage software. The gateway currently uses local identity, an allow-all policy, and an in-memory audit sink. It binds to loopback by default; do not expose it to an untrusted network. See [Security](#security) before changing the bind address.

## What it does today

- Runs a gateway over Effect RPC, with a health endpoint at `GET /health`.
- Starts a full-screen terminal chat or accepts one-shot prompts.
- Connects to OpenAI/Codex, Anthropic, Z.AI, and OpenCode Zen model providers.
- Lets agents use workspace-confined file tools and a shell tool, in the foreground or as background tasks they read, wait on, stop, list, and are told about when they end: at once, in a run the gateway starts, while the chat is open, or at the next message otherwise.
- Stores conversations on disk and supports continuing or resuming them.
- Loads additional agents from YAML, reloads them on `SIGHUP`, and can watch their directory.
- Loads built-in, local-file, package, and MCP tool plugins.

## Quick start

### 1. Install dependencies

[magentic uses Bun](https://bun.sh), not npm, pnpm, or yarn.

```sh
bun install
```

### 2. Sign in to a model provider

```sh
bun apps/cli/src/main.ts auth login
bun apps/cli/src/main.ts auth list
```

Follow the provider picker. Credentials are kept in your magentic data directory, not in project configuration.

### 3. Start chatting

```sh
# Opens the terminal UI. If no local gateway is running, the CLI starts one for this session.
bun apps/cli/src/main.ts

# Or open it with a message already sent.
bun apps/cli/src/main.ts "Explain this repository"

# Or print the reply and exit; for scripts, pipes and CI.
bun apps/cli/src/main.ts -p "Explain this repository"
```

The command line follows pi: `magentic [flags] [--] [@files...] [message...]`. `-p` (`--print`) is the non-interactive mode. The message comes from the arguments, from stdin, or both (the arguments first, then what was piped), so `git diff | magentic -p "Review this"` works, and so does `echo "prompt" | magentic` from a pipe or a service, where the chat cannot draw and prints instead. `@path` puts a file in the message: images go along as attachments, anything else as a block of text under its path. The reply goes to stdout and tool activity to stderr, so the reply alone reaches the next command. `--mode json` prints every run event as one JSON line instead, in the wire shape of `RunEvent`; the first, `RunStarted`, carries the conversation id, which `-s <id>` continues later, as `-c` continues the newest. `-a <agent>` picks the agent, `-m provider/model` the model and `--thinking <level>` its thinking level. The exit code is 1 when the run fails.

The built-in `assistant` can inspect, edit, and run commands in the current workspace. While it works you can keep typing: a message sent then is steered into the run, listed above the composer until the model reads it before its next call, so you can redirect the agent without stopping it. A slash command sent during a run waits for it to end. `↑` on an empty composer takes back what the model has not read yet for editing; `Esc` stops the run and does the same.

A few keys shape the run. `ctrl+t` cycles the model's thinking level (the catalog's effort names, or `high` and `max` budgets) and the footer shows the level in force; `ctrl+o` opens every tool result in full under its call, where edits already show as a diff. The footer also shows how much of the context window is in use and, for metered models, what the session has cost so far at the catalog's prices.

List the agents available to the gateway with:

```sh
bun apps/cli/src/main.ts agents
```

## Run the gateway

For a long-running local gateway:

```sh
bun run dev
# Gateway: http://127.0.0.1:4321
# Health:  http://127.0.0.1:4321/health
```

Point the CLI at another gateway with `--gateway` (or `-g`):

```sh
bun apps/cli/src/main.ts --gateway http://gateway.internal:4321 agents
bun apps/cli/src/main.ts --gateway http://gateway.internal:4321 -p "Summarize the latest changes"
```

Useful CLI commands:

```sh
bun apps/cli/src/main.ts --help
bun apps/cli/src/main.ts plugin list
bun apps/cli/src/main.ts -c                 # continue the latest conversation
bun apps/cli/src/main.ts -r <conversation>  # resume a conversation by id
```

## Configure agents

By default magentic looks for configuration in `./magentic`. Set `MAGENTIC_HOME` to use another directory. Add agent definitions under `agents/`; the built-in `assistant` remains available.

```text
magentic/
├── magentic.yaml
└── agents/
    └── reviewer.yaml
```

`magentic/agents/reviewer.yaml`:

```yaml
name: reviewer
description: Reviews changes in the current workspace.
model: anthropic/claude-sonnet-4-5
prompt: |
  Review the user's requested change carefully.
  Explain risks clearly and cite files and line numbers.
tools: [read_file, glob, grep]
maxSteps: 12
```

`tools` is an allow-list. An entry names one tool, or ends in `*` to take every tool with that prefix (`github_*` for one MCP server), or is a capability followed by `:*` to take every tool declaring it (`mcp:*` for every MCP server, `fs:read:*` for every reader). A file named after the built-in `assistant` replaces it.

An agent’s `prompt` can also load a file relative to the configuration directory:

```yaml
prompt:
  file: prompts/reviewer.md
```

Use `reload: watch` in `magentic.yaml` to rebuild configured agents when their files change. Sending `SIGHUP` to the gateway also reloads them.

```yaml
reload: watch

# Disable a built-in tool everywhere.
tools:
  shell: false

# Disable a built-in plugin or load a trusted external plugin.
plugins:
  disable: []
  use: []
```

See [docs/plugins.md](docs/plugins.md) for plugin and MCP configuration. Treat external plugins as trusted code: they run in the gateway process with its privileges.

## Environment

Bun loads `.env` from the working directory. Do not commit credentials.

| Variable                   | Default                              | Purpose                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                     | `4321`                               | Gateway port.                                                                                                                                                                                           |
| `MAGENTIC_HOST`            | `127.0.0.1`                          | Address on which the gateway listens.                                                                                                                                                                   |
| `IDENTITY_LOCAL`           | `false`                              | Explicitly permits a non-loopback bind with local identity. See [Security](#security).                                                                                                                  |
| `MAGENTIC_HOME`            | `./magentic`                         | Configuration directory containing `magentic.yaml` and `agents/`.                                                                                                                                       |
| `MAGENTIC_DATA_DIR`        | `$HOME/.config/magentic`             | Local conversations, CLI state, `gateway.log` from a gateway the CLI started, and `tool-output/` with the full output of shell commands too long to show the model whole, and of every background task. |
| `MAGENTIC_WORKSPACE`       | Current working directory            | Root available to built-in file and shell tools.                                                                                                                                                        |
| `MAGENTIC_API_KEYS_FILE`   | `$MAGENTIC_DATA_DIR/api-keys.json`   | Stored model API keys.                                                                                                                                                                                  |
| `MAGENTIC_CODEX_AUTH_FILE` | `$MAGENTIC_DATA_DIR/codex-auth.json` | Stored ChatGPT/Codex login.                                                                                                                                                                             |
| `CODEX_HOME`               | `$HOME/.codex`                       | Codex CLI directory used when importing its login.                                                                                                                                                      |
| `MAGENTIC_MODELS_URL`      | `https://models.dev/api.json`        | Model catalog source.                                                                                                                                                                                   |
| `MAGENTIC_MODELS_CACHE`    | `$HOME/.cache/magentic/models.json`  | Cached model catalog.                                                                                                                                                                                   |
| `MAGENTIC_MODELS_OFFLINE`  | `false`                              | Use only the cached or bundled model catalog.                                                                                                                                                           |
| `USER`                     | `local`                              | Subject assigned by local identity.                                                                                                                                                                     |

## Security

The gateway is deliberately conservative while authentication is still under development:

- It listens on `127.0.0.1` by default.
- Setting `MAGENTIC_HOST` to anything else fails unless you also set `IDENTITY_LOCAL=true`.
- With local identity enabled, callers on the reachable network are trusted as the local user.
- The current policy allows actions and the audit sink is in memory. Do not treat this as a multi-tenant or production authorization boundary.
- Built-in workspace tools are confined to `MAGENTIC_WORKSPACE`; the shell tool runs with the gateway process’s privileges inside that workspace. A background task runs until it ends, is stopped, or the gateway exits, and only the principal who started it can read or stop it.

For the intended identity and policy model, read [docs/identity.md](docs/identity.md). For a public deployment, keep the gateway behind a trusted network boundary until authenticated edge support lands.

## Development

```sh
bun run dev        # gateway with reload
bun run test       # Vitest suite on the Bun runtime
bun run typecheck  # TypeScript checks
bun run lint       # oxlint and formatting check
bun run check      # typecheck + lint + knip + tests
```

This is a Bun workspace built on [Effect](https://effect.website) 4. Read [CLAUDE.md](CLAUDE.md) for repository conventions and contributor commands.

## Repository layout

| Path                     | Responsibility                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `apps/gateway`           | Gateway server: configuration, plugin hosting, RPC routes, and service wiring.                       |
| `apps/cli`               | `magentic` terminal client and full-screen chat.                                                     |
| `packages/protocol`      | Shared schemas and Effect RPC API.                                                                   |
| `packages/core`          | Agent runtime, conversations, plugin host, retries, and configuration primitives.                    |
| `packages/plugin`        | Public plugin contract and model catalog.                                                            |
| `packages/model`         | Model-provider plugins, API keys, and Codex login.                                                   |
| `packages/tools`         | Workspace-confined file and shell tools.                                                             |
| `packages/mcp`           | MCP client plugin and MCP-provided tools.                                                            |
| `packages/bridge-github` | GitHub bridge plugin: mentions on issues and pull requests become runs; forge tools push as the App. |
| `packages/identity`      | Identity abstractions and local identity implementation.                                             |
| `packages/policy`        | Policy decisions and enforcement interfaces.                                                         |
| `packages/audit`         | Audit interfaces and current in-memory implementation.                                               |
| `docs/`                  | Design notes, configuration details, and research.                                                   |

## Documentation

- [Harness design](docs/harness.md) — architecture, request lifecycle, and delivery phases.
- [Identity design](docs/identity.md) — planned credentials, sessions, and authorization boundary.
- [Plugin guide](docs/plugins.md) — plugin contract, external plugins, and MCP servers.

## License

[MIT](LICENSE)
