<p align="center">
  <img src="docs/logotype.svg" width="481" alt="magentic" />
</p>

magentic runs coding agents from your terminal or a self-hosted gateway. Agents can
read and edit files, run shell commands, fetch web pages, and use tools from plugins
and MCP servers. Conversations are saved on disk so you can pick them up later.

Built with Bun and Effect 4. Supports OpenAI/Codex, Anthropic, Z.AI, and OpenCode Zen.

Still early. Local gateway access trusts the local user; paired browsers have the
same authority. Policy allows all actions and audit records live in memory. Keep
the local port private and use the authenticated relay connection for remote access.

## Getting started

Install [Bun](https://bun.sh), then run these from the repository:

```sh
bun install
bun apps/cli/src/main.ts auth login
bun apps/cli/src/main.ts
```

The login command walks you through choosing a provider. Credentials live in your
magentic data directory, separate from project configuration.

The CLI opens a terminal chat and starts a local gateway if one isn't already
running. The default `assistant` works in the current directory.

To send a prompt immediately, or print a reply and exit:

```sh
bun apps/cli/src/main.ts "Explain this repository"
bun apps/cli/src/main.ts -p "Explain this repository"
git diff | bun apps/cli/src/main.ts -p "Review this diff"
```

## Using the CLI

| Option                  | What it does                                            |
| ----------------------- | ------------------------------------------------------- |
| `-p`, `--print`         | Print the reply and exit. Tool activity goes to stderr. |
| `-c`                    | Continue the latest conversation.                       |
| `-s <id>`               | Continue a conversation by ID.                          |
| `-a <agent>`            | Choose an agent.                                        |
| `-m provider/model`     | Choose a model.                                         |
| `--thinking <level>`    | Set the model's thinking level.                         |
| `--mode json`           | Print run events as JSON lines.                         |
| `-g`, `--gateway <url>` | Connect to a running gateway.                           |
| `--help`                | Show all commands and options.                          |

Use `@path` to include a file in a prompt. Images become attachments; other files
are included as text. Piped input is appended to any prompt arguments. Without an
interactive terminal, the CLI prints the reply and exits. Failed runs exit with
code 1.

JSON output uses the protocol's `RunEvent` format. The first event, `RunStarted`,
includes the conversation ID for use with `-s`.

In terminal chat, you can send another message while the agent works. It waits above
the composer until the model reads it before its next call. Slash commands wait
until the run ends.

| Key                        | Action                                      |
| -------------------------- | ------------------------------------------- |
| `↑` with an empty composer | Take back unread messages for editing.      |
| `Esc`                      | Stop the run and take back unread messages. |
| `Ctrl+T`                   | Cycle the model's thinking level.           |
| `Ctrl+O`                   | Expand tool results. Edits show as diffs.   |

The footer shows the thinking level, context usage, and estimated session cost for
metered models.

```sh
bun apps/cli/src/main.ts agents       # list available agents
bun apps/cli/src/main.ts auth list    # list provider credentials
bun apps/cli/src/main.ts plugin list # list plugins
```

## Running a gateway

For a gateway that stays running between CLI sessions:

```sh
bun run dev
```

It listens at `http://127.0.0.1:4321`, serves Effect RPC at `/rpc`, and has a health
endpoint at `GET /health`.

To connect to another gateway:

```sh
bun apps/cli/src/main.ts --gateway http://gateway.internal:4321
```

Read the [security notes](#security) before making the gateway reachable over a network.

## Remote control

The gateway connects to your relay in the background. You do not need to run a
separate connector. The relay application lives in [apps/relay](apps/relay).

First, mint a gateway credential using your relay's admin API (see its README).
Save it once with the masked prompt:

```sh
bun apps/cli/src/main.ts relay-setup --url https://relay1.magentic.run
```

This saves `relay.json` under `MAGENTIC_DATA_DIR` with permissions `0600`. The file
contains `url`, `token`, and optionally `publicUrl` when the browser uses a different
hostname. You can also supply `MAGENTIC_RELAY_URL`, `MAGENTIC_RELAY_TOKEN`, and
`MAGENTIC_REMOTE_URL` through the environment. Use HTTPS outside local development.
Restart an already-running gateway after changing these settings.

Open the CLI and enter `/rc`. Scan the QR code to pair your browser; the link lasts
five minutes and pairs up to four browsers, so a phone that opens it in an in-app
view first can still reopen the same link in its real browser. The browser then
opens the conversation list and can read or continue a chat. While a link is still
good, `/rc` shows it again; otherwise `/rc` shows a link to the current
conversation. `/remote-control` is an alias.

| Command           | Action                                                       |
| ----------------- | ------------------------------------------------------------ |
| `/rc pair`        | Pair another browser, reusing a pairing link with time left. |
| `/rc status`      | Show relay connection status.                                |
| `/rc devices`     | List paired browsers and their IDs.                          |
| `/rc revoke <id>` | Remove a browser's access and close its open requests.       |
| `/rc off`         | Disconnect remote access, keeping the device list.           |
| `/rc on`          | Reconnect and accept paired browsers again.                  |

Device credentials have no server-side expiry and survive gateway restarts. The
browser keeps its login in an HttpOnly cookie, renewed when used; clearing site
data, browser storage limits, signing out, or revoking the device requires pairing
again. The pairing link stays in the address bar only until it expires, so it can
be carried to another browser, and never longer.

When relay settings exist, the CLI starts a detached gateway and reuses it on later
launches. Quitting the CLI leaves that gateway, its relay connection, and background
tasks running. Without relay settings, the CLI still starts an embedded gateway
that exits with it. To stop a running gateway explicitly:

```sh
bun apps/cli/src/main.ts gateway stop
```

The computer must be awake and online to handle remote requests. The connector
retries after network changes or sleep. A reboot requires starting magentic again;
this does not install an operating-system startup service. Logs go to
`MAGENTIC_DATA_DIR/gateway.log`.

The browser refreshes saved transcripts and streams replies it starts. It does not
yet mirror an in-progress terminal reply token by token. A run started by a client
still ends if that client disconnects; background tasks belong to the gateway.

## Agents and tools

Configuration lives in `./magentic`, or the directory set by `MAGENTIC_HOME`:

```text
magentic/
├── magentic.yaml
└── agents/
    └── reviewer.yaml
```

For example, `agents/reviewer.yaml` defines a read-only reviewer:

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

Run it with `-a reviewer`. The built-in `assistant` stays available unless you
replace it with an agent file of the same name.

The `tools` list accepts exact names, prefixes such as `github_*`, and capabilities
such as `mcp:*` or `fs:read:*`. To keep a prompt in a separate file, use a path
relative to the configuration directory:

```yaml
prompt:
  file: prompts/reviewer.md
```

In `magentic.yaml`, you can watch agent files for changes, disable tools, and load
plugins:

```yaml
reload: watch

tools:
  shell: false

plugins:
  disable: []
  use: []
```

Sending `SIGHUP` to the gateway also reloads agents.

Plugins can come from built-ins, local files, packages, or MCP servers. They can
also serve HTTP routes under `/plugins/<id>/`. The GitHub bridge uses this to turn
issue and pull request mentions into agent runs, with replies and forge actions
performed as the GitHub App.

See the [plugin guide](docs/plugins.md) for setup. External plugins run with the
gateway's privileges; only load code you trust.

## Environment

Bun loads `.env` from the working directory. Keep credentials out of version control.

| Variable                   | Default                              | Purpose                                                                |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `PORT`                     | `4321`                               | Gateway port.                                                          |
| `MAGENTIC_HOST`            | `127.0.0.1`                          | Listen address.                                                        |
| `IDENTITY_LOCAL`           | `false`                              | Permit a non-loopback bind with local identity.                        |
| `MAGENTIC_HOME`            | `./magentic`                         | Configuration directory.                                               |
| `MAGENTIC_DATA_DIR`        | `$HOME/.config/magentic`             | Conversations, CLI state, gateway logs, and saved tool output.         |
| `MAGENTIC_WORKSPACE`       | Current directory                    | Working directory for file and shell tools.                            |
| `MAGENTIC_API_KEYS_FILE`   | `$MAGENTIC_DATA_DIR/api-keys.json`   | Stored provider API keys.                                              |
| `MAGENTIC_CODEX_AUTH_FILE` | `$MAGENTIC_DATA_DIR/codex-auth.json` | Stored ChatGPT/Codex login.                                            |
| `CODEX_HOME`               | `$HOME/.codex`                       | Codex CLI directory when importing a login.                            |
| `MAGENTIC_MODELS_URL`      | `https://models.dev/api.json`        | Model catalog source.                                                  |
| `MAGENTIC_MODELS_CACHE`    | `$HOME/.cache/magentic/models.json`  | Model catalog cache.                                                   |
| `MAGENTIC_MODELS_OFFLINE`  | `false`                              | Use only the cached or bundled catalog.                                |
| `USER`                     | `local`                              | Subject assigned by local identity.                                    |
| `GITHUB_APP_PRIVATE_KEY`   | Unset                                | GitHub App private key. Literal `\n` sequences become newlines.        |
| `GITHUB_WEBHOOK_SECRET`    | Unset                                | Webhook signing secret. Without it, the bridge rejects all deliveries. |

## Security

The gateway binds to loopback by default. Other bind addresses require
`IDENTITY_LOCAL=true`, which trusts reachable callers as the local user. There is
no production authorization boundary yet: policy allows all actions and audit
records are held in memory.

File tools are confined to `MAGENTIC_WORKSPACE`. The shell starts in that directory
but runs with the gateway process's privileges. Background commands run until they
finish, are stopped, or the gateway exits. Only the principal who started a
background task can read or stop it.

For webhook bridges, expose only `/plugins/<id>/` through a tunnel or reverse proxy.
The plugin verifies webhook signatures; `/rpc` still trusts callers as the local
user and should remain private.

The [identity design](docs/identity.md) describes the planned authentication and
policy model.

## Development

```sh
bun run dev        # gateway with reload
bun run test       # Vitest suite on Bun
bun run typecheck  # TypeScript checks
bun run lint       # lint and formatting checks
bun run check      # typecheck, lint, unused-code checks, and tests
```

`apps/gateway` hosts agents and wires services together. `apps/cli` is the terminal
client, `apps/web` is the Solid browser client, and `apps/relay` deploys separately to
Cloudflare or runs as a Bun server. Shared packages under `packages/` cover the runtime, RPC protocol, model
providers, tools, plugins, identity, policy, and audit.

- [Repository conventions](CLAUDE.md)
- [Harness design](docs/harness.md)
- [Identity design](docs/identity.md)
- [Plugin guide](docs/plugins.md)

## License

[MIT](LICENSE)
