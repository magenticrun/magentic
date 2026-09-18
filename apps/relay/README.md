# magentic-relay

A magentic gateway on a laptop has no public address, and it must not open an
inbound port. This is what a phone reaches instead: the gateway dials out to a
relay over one WebSocket and serves its ordinary protocol over that
connection, and the relay hands every device that arrives on its hostname
through to it.

This is the relay application in the magentic workspace. It deploys independently
of the gateway, and its connector is imported by the gateway as
`@magentic/relay/connector`. Device credentials and conversations stay in the gateway.

## What it does, and what it deliberately does not

The relay forwards bytes. A device makes an ordinary HTTP request or opens an
ordinary WebSocket against the relay's hostname; the gateway on the other end
sees an ordinary client, with `x-forwarded-for`, `x-forwarded-host`, and
`x-forwarded-proto` set. Device pairing, credentials, scopes, policy, and audit
all stay in the gateway, exactly as they are on the direct path.

The relay therefore never parses an RPC and holds no conversation state. It
knows one kind of caller by name: the gateway that dials into it. The optional
features a relay could grow — queueing a device's commands while the gateway
sleeps, mirroring committed journal entries so the app is never empty, fanning
out push — are not built here and would be this project's own work against the
published `@magentic/protocol` schemas, never a dependency of core.

## Running it

Cloudflare is the recommended home: one Worker, one hibernatable Durable
Object per gateway, both ends of a gateway's tunnel on the same object, asleep
when nothing is being said.

```sh
bun install
bunx wrangler secret put RELAY_ADMIN_TOKEN
bun run deploy
```

Set `RELAY_ZONE` to the hostname suffix that names a gateway, so
`laptop.relay.example.com` reaches the gateway `laptop`; or leave it empty and
set `RELAY_GATEWAY` for a relay that serves one gateway on one hostname.

The same code runs as one Bun process behind a TLS proxy, for an operator who
already has a box and wants no Cloudflare account:

```sh
RELAY_ADMIN_TOKEN=… RELAY_GATEWAY=laptop PORT=8787 bun run dev
```

## Connecting a gateway

Mint a credential, which is shown once:

```sh
curl -X POST https://relay.example.com/_relay/admin/gateways/laptop/credentials \
  -H "authorization: Bearer $RELAY_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"label":"my laptop"}'
```

From the repository root, save the credential in magentic's masked setup prompt:

```sh
bun apps/cli/src/main.ts relay-setup --url https://relay.example.com
```

Start magentic and enter `/rc`. The gateway connects in the background and keeps
running when the CLI exits. The connector reconnects after sleep or a network
change. Device pairing, persistent browser logins, and revocation belong to the
gateway. See [Remote control](../../README.md#remote-control).

`bin/connect.ts` remains available for testing a generic tunnel. It forwards to
whatever server you name and does not add device authentication; magentic's
integrated connection forwards through its authenticated remote listener instead.

## Admin API

Every route lives under `/_relay/`, which is the only prefix the relay keeps
for itself; everything else on the hostname is tunnelled. All of these need
`authorization: Bearer $RELAY_ADMIN_TOKEN`.

| Route                                                | Does                                     |
| ---------------------------------------------------- | ---------------------------------------- |
| `GET /_relay/health`                                 | whether this hostname's gateway is up    |
| `GET /_relay/admin/gateways/<id>`                    | connection status and open socket counts |
| `POST /_relay/admin/gateways/<id>/credentials`       | mint one; the token is shown once        |
| `GET /_relay/admin/gateways/<id>/credentials`        | list fingerprints, never secrets         |
| `DELETE /_relay/admin/gateways/<id>/credentials/<f>` | revoke, and hang up if it is in use      |

Credentials are `mrk_<gatewayId>.<secret>`. The gateway id is in the clear so
the relay can route on it before reading any state; the secret is stored only
as a SHA-256 hash and compared in constant time.

## The wire

One WebSocket carries every device. Text frames are JSON control messages;
binary frames are `[channel][stream id][payload]`, where the channel is an
HTTP body chunk, a WebSocket text message, or a WebSocket binary message. The
relay allocates stream ids, because the relay is the only side that starts a
stream. `src/protocol.ts` is the whole of it.

Keepalives are the literal strings `ping` and `pong` rather than JSON, so a
Durable Object answers them with `setWebSocketAutoResponse` without waking up.

**Windows.** Each body stream has a one megabyte send window in each
direction, and the reader grants more as its own consumer takes the bytes. A
pause message would not do the job: between saying stop and being heard lies a
round trip, and a fast writer fills that round trip with as much as it likes.
This is what keeps a phone downloading slowly from parking the whole of a
large response in a Durable Object with 128 MB to its name.

**Streams are marked `content-encoding: identity`.** A response the gateway
did not size is one it is still producing, and a runtime that compresses a
compressible body waits for the whole of it first: without this, a streamed
answer arrives in one piece at the end. Sized responses are left alone, so
assets still compress on the wire. This is the one thing the Worker got wrong
that the Bun process did not, which is why both are tested.

## Checking it

```sh
bun run check   # typecheck (Bun and Worker), lint, Vitest tests on Bun
```

One suite in `test/relay-suite.ts` runs twice: against the Bun process, and
against the Worker on real workerd through `wrangler dev`, which needs no
Cloudflare account. Cloudflare is where this is meant to run, so it is the
path that most needs a test, and it has already earned one. Each run drives a
real relay, a real connector, and a stand-in gateway over real sockets, and
asserts only what a device on the far side would see: status and path
passthrough, a 300 KB body across many frames, a 16 MB body far past one
window, forwarded headers replacing a client's own, a streamed response
arriving before it ends, a WebSocket echoing both ways, admin auth, the plain
503 a device gets when the gateway is not connected, and a gateway that comes
back serving again. The send window itself is asserted directly against the
tunnel in `test/bun-relay.test.ts`, because end to end the number is swamped
by Bun's and wrangler's own buffers.

Set `RELAY_SKIP_WORKER=1` to skip the workerd run.

## Known limits

- No queue and no mirror. A command sent while the gateway is asleep is
  refused with 503, and the device's own outbox is what retries it.
- One gateway connection at a time per id. A second one replaces the first,
  which is the same operator's laptop reconnecting after sleep.
- No cap on how many streams one gateway's devices may have open at once. The
  window bounds each stream's memory; nothing bounds their number.
- Streamed responses are not compressed on the wire, which is the price of
  their arriving as they are produced.
