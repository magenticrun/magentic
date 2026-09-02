# Identity design

Identity answers one question for every request: who is asking. The answer is a `Principal`,
resolved once at the gateway edge and carried through policy, the runner, and audit. Nothing
downstream authenticates again.

## Principles

- **One principal type, many providers.** `Principal.id` is stable and namespaced by
  provider: `slack:U0123`, `okta:00u1abc`, `local:bruno`, `token:t_9f3a`, `system:cron/nightly`.
- **A person can have several identities.** A `users` row is the canonical person; an
  `identities` row links `(provider, subject)` to it. Groups and audit attach to the user, so
  someone who asks from Slack and from Cursor is the same actor.
- **Groups come from the provider and are mirrored locally.** Okta groups, Slack user groups,
  and a local `groups.yaml` override all merge into `Principal.groups`. Policy only sees the
  merged list.
- **Credentials are never stored raw.** Session and personal access tokens are stored as a
  SHA-256 hash. The plain token is shown once at issue time.
- **Machine principals are explicit.** Cron and API keys act as `system:*` or `token:*`
  principals with an `onBehalfOf` user, so policy can be stricter and audit still names a
  person.

## Credential kinds

`Identity.authenticate(credential)` takes a tagged union and returns a `Principal` or an
`IdentityError` with a `reason`.

| Credential     | Comes from                                    | Verified by                                                                                        |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `BearerToken`  | CLI, Cursor, HTTP callers                     | hash lookup in `sessions` or `tokens`, expiry, revoke                                              |
| `SlackRequest` | Slack Events API and interactivity payloads   | HMAC of `v0:<ts>:<body>` with the signing secret, 5 minute window, then `user` id from the payload |
| `ApiKey`       | CI and services                               | hash lookup in `tokens` where `kind = "service"`                                                   |
| `LocalSubject` | dev mode only, gated by `IDENTITY_LOCAL=true` | trusted as-is                                                                                      |

## Providers

Each provider is a `Context.Service` with the same shape, so the gateway composes the ones
that are configured.

```ts
interface IdentityProvider {
  readonly name: IdentityProviderName; // "slack" | "okta" | "local"
  resolve(subject: string): Effect<ProviderIdentity, IdentityError>; // display name, email, groups
}
```

- **Local** (exists as `layerLocal`). Kept for single-user and tests.
- **Slack.** `resolve` calls `users.info` (scope `users:read`, plus `users:read.email` for
  linking) and `usergroups.list`, cached with `PersistedCache` for an hour. Subject is the
  Slack user id.
- **Okta, as a generic OIDC provider with an Okta preset.** The implementation is plain OIDC:
  discovery document, JWKS, RS256 ID token validation of `iss`, `aud`, `exp`, `nonce`.
  Groups come from a `groups` claim, which in Okta needs a custom claim on the authorization
  server, so the docs say how to add it and the provider falls back to `userinfo` when the
  claim is absent. Naming it OIDC keeps Google Workspace and Entra one config change away.

## Directory sync

Resolving a subject on first contact works, but a team gateway should already know its
people and groups before anyone talks to it. Otherwise policy rules like `group:sre` are
empty until each member happens to show up. Sync fills `users`, `identities`, and `groups`
ahead of time; on-demand `resolve` stays as the fallback for a subject sync has not seen.

Three mechanisms, layered from simplest to freshest:

**1. Pull sync on a schedule (both providers, phase 2).** A built-in cron job, `Schedule.cron`
in-process, runs `DirectorySync.run` every 15 minutes and on gateway start.

| Provider | Reads                                                                                                  | Credential                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Okta     | `GET /api/v1/users`, `GET /api/v1/groups`, `GET /api/v1/groups/{id}/users`, paginated by `Link` header | OAuth service app with `okta.users.read` and `okta.groups.read`, or an API token |
| Slack    | `users.list`, `usergroups.list`, `usergroups.users.list`                                               | bot token with `users:read`, `users:read.email`, `usergroups:read`               |

Each run upserts identities, replaces group memberships per provider, marks users the
provider reports as deactivated with `disabled_at`, and links Slack and Okta identities to
one user by verified email. Deleted subjects are disabled, never removed, so audit rows keep
resolving. Every run writes one audit event with counts.

**2. Event-driven updates (freshness, phase 3).** Slack already sends events to the gateway,
so subscribe to `team_join`, `user_change`, `subteam_created`, `subteam_updated`, and
`subteam_members_changed` and apply them incrementally. Okta can post Event Hooks for
`user.lifecycle.*` and `group.user_membership.add` / `.remove` to a verified endpoint. Both
feed the same `DirectorySync.apply(change)` path the pull sync uses, so there is one writer.

**3. SCIM push from Okta (enterprise, later).** Okta's provisioning engine can push users
and groups into any app that serves SCIM 2.0. The gateway would expose `/scim/v2/Users` and
`/scim/v2/Groups` (bearer auth, `filter=userName eq`, `PATCH` for membership changes) and
Okta would create, update, deactivate, and assign in near real time with no polling. This is
what security teams expect from a system that does access control, so it is worth doing,
but pull sync covers the same data and ships first. Slack has no equivalent push; its SCIM
API is Slack acting as the server for Business+ and Enterprise Grid, usable for reads only.

`DirectorySync` is a `Context.Service` in `@magentic/identity` with `run`, `apply(change)`,
and `status`. `magentic directory sync` triggers it from the CLI; `magentic directory
status` shows last run, counts, and linking gaps.

## Flows per surface

**Slack.** No login. The signed request proves Slack sent it; the payload's user id is the
subject. Directory sync has usually already created the `users` row and `slack` identity;
first contact creates them when it has not. If OIDC is configured and
`identity.requireLink` is true, the bot replies with a link prompt until the Slack identity is
linked to an OIDC identity by verified email match.

**CLI.** `magentic login` opens the browser to `GET /sessions/login` on the gateway, which
starts an OIDC authorization code flow with PKCE and redirects back to a localhost port the
CLI is listening on. The gateway exchanges the code, validates the ID token, upserts the user,
and issues a session token. The CLI stores it in `~/.config/magentic/credentials.json`
(mode 600) and sends it as `Authorization: Bearer`. Without OIDC, `magentic login --local
<name>` issues a session directly when local identity is enabled. Sessions expire after
`SESSION_TTL` (default 30 days) with sliding renewal.

**Cursor.** MCP over Streamable HTTP with a bearer token. The user creates a personal access
token with `magentic tokens create --name cursor` and pastes it into Cursor's MCP config.
Tokens can be scoped to a set of agents. MCP OAuth is a later addition, not required for
launch.

**HTTP and CI.** Service tokens, `kind = "service"`, created by an admin with
`magentic tokens create --service --on-behalf-of <user> --agents deploy-bot`. They act as
`token:<id>` with `onBehalfOf` set.

**Cron.** No credential. The scheduler builds `system:cron/<job>` with `onBehalfOf` from the
job definition. Policy gets both, audit records both.

## Gateway middleware

```ts
class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()("magentic/identity/CurrentPrincipal") {}

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { reason: ... }, { httpApiStatus: 401 }) {}

class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentPrincipal }>()(
  "magentic/gateway/Authentication",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized, requiredForClient: true },
) {}
```

- `Authentication` is attached to every group except `system.health`, `sessions.login`, and
  `slack`. The middleware's `bearer` handler calls `Identity.authenticate(BearerToken)` and
  provides `CurrentPrincipal` to the handler. `requiredForClient: true` means the CLI's
  generated client must supply the token, so it cannot be forgotten.
- `SlackSignature` is a second middleware on the `slack` group with no security scheme. It
  reads the raw body and headers, verifies the HMAC, and provides `CurrentPrincipal` from the
  payload's user id.
- `/mcp` is a plain `HttpRouter` route, so the bearer check is a router-level middleware
  around `McpServer.layerHttp` that puts `CurrentPrincipal` in context for the MCP tool
  handlers.

## Services (`@magentic/identity`)

| Service         | Responsibility                                                              | Layers                         |
| --------------- | --------------------------------------------------------------------------- | ------------------------------ |
| `Identity`      | `authenticate(credential)`: dispatch on credential tag, produce `Principal` | `layer` (needs the ones below) |
| `UserDirectory` | users, identities, links, merged groups                                     | `layerMemory`, `layerSql`      |
| `SessionStore`  | issue, verify, renew, revoke session tokens                                 | `layerMemory`, `layerSql`      |
| `TokenStore`    | personal and service tokens with scopes                                     | `layerMemory`, `layerSql`      |
| `SlackProvider` | signature verification, `users.info`, user groups                           | `layer` (needs `HttpClient`)   |
| `OidcProvider`  | discovery, PKCE, code exchange, ID token validation, groups                 | `layer`, `layerOkta(preset)`   |
| `LocalProvider` | trusted subjects for dev                                                    | `layerLocal` (exists)          |

Token generation uses `Random` and `Redacted`; hashing uses Bun's `crypto.subtle` behind an
Effect service so tests can be deterministic.

## Schema

```
users        id, display_name, email, created_at, disabled_at
identities   provider, subject, user_id, display_name, email, groups_json, refreshed_at   PK(provider, subject)
sessions     id, user_id, token_hash, surface, issued_at, expires_at, last_used_at, revoked_at
tokens       id, user_id, kind, name, token_hash, agents_json, on_behalf_of, created_at, expires_at, revoked_at
groups       name, user_id                                                                 (local overrides)
```

## Errors

`IdentityError` gets a `reason` union: `MissingCredential`, `InvalidToken`, `ExpiredToken`,
`RevokedToken`, `BadSignature`, `StaleTimestamp`, `UnknownSubject`, `ProviderUnavailable`,
`LinkRequired`. The HTTP mapping is 401 for everything except `LinkRequired`, which is 403
with a body the surfaces can render as "link your account".

## Testing

- `HttpApiTest.groups` with `Authentication` provided by a memory `SessionStore` seeded with a
  known token.
- Slack signature tests sign fixture bodies with a known secret and assert both the happy path
  and each `reason`.
- OIDC tests use a fake issuer served by an in-process `HttpApi` with a generated JWKS, so no
  network and no Okta tenant in CI.

## Configuration

Non-secret settings live in `magentic.yaml` under `identity:` and `sync:` (see the
configuration section of `harness.md`) and reload with the rest of the directory. Secrets
come from the environment:

```
IDENTITY_LOCAL=true                      dev only
IDENTITY_REQUIRE_LINK=false              when OIDC is set, must Slack users be linked
SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_GROUPS_CLAIM=groups
OKTA_ORG_URL, OKTA_API_TOKEN (or OKTA_SYNC_CLIENT_ID + private key)   directory sync
DIRECTORY_SYNC_CRON="*/15 * * * *"
SESSION_TTL=30 days
```

All read through `Config`, secrets through `Config.Redacted`.
