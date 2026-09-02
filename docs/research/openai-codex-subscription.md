# OpenAI Codex "Sign in with ChatGPT" for a magentic language-model provider

Research notes for implementing a `@magentic` LanguageModel provider that authenticates with a
ChatGPT Plus/Pro/Team subscription the way the OpenAI Codex CLI does, instead of an API key.

Everything below is read directly from two repositories at the commits named in "Sources":

- `openai/codex` at `612e6491d50ffb80ffc4330edc4024b86e51e4bf` (2026-09-01). Paths are relative
  to the repo root; the Rust crates live under `codex-rs/`.
- `anomalyco/opencode` at `8ff796f13373394499378697002327e222dcc8fa` (2026-09-01).

Anything the code does not show is marked **unverified**. No blog posts were used. The Codex
repo's own docs page on auth is a single link to `https://developers.openai.com/codex/auth`
(`docs/authentication.md`), which was not consulted (not a repo source).

Terminology: "issuer" is `https://auth.openai.com`; "backend" is `https://chatgpt.com/backend-api`.

---

## 1. OAuth login flow used by Codex CLI (browser, PKCE)

Implemented in `codex-rs/login/src/server.rs` (`run_login_server`, `build_authorize_url`,
`process_request`, `exchange_code_for_tokens`, `obtain_api_key`, `persist_tokens_async`) and
`codex-rs/login/src/pkce.rs` (`generate_pkce`).

| Item          | Value                                                                                                                                                                                                                                                                           | Source                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Issuer        | `https://auth.openai.com` (`DEFAULT_ISSUER`)                                                                                                                                                                                                                                    | `login/src/server.rs`                    |
| Authorize URL | `{issuer}/oauth/authorize?<query>`                                                                                                                                                                                                                                              | `build_authorize_url`                    |
| `client_id`   | `app_EMoamEEZ73f0CkXaXp7hrann` (`pub const CLIENT_ID`), overridable via env `CODEX_APP_SERVER_LOGIN_CLIENT_ID` (`oauth_client_id()`)                                                                                                                                            | `login/src/auth/manager.rs:1708`, `:201` |
| Scopes        | `openid profile email offline_access api.connectors.read api.connectors.invoke`                                                                                                                                                                                                 | `build_authorize_url`                    |
| Redirect URI  | `http://localhost:{port}/auth/callback`                                                                                                                                                                                                                                         | `run_login_server`                       |
| Callback port | `1455` (`DEFAULT_PORT`), fallback `1457` (`FALLBACK_PORT`, comment: "Keep in sync with the Codex CLI Hydra redirect URI allow-list"). Binds `127.0.0.1`. If the port is busy it sends `GET /cancel` to the previous login server, retries 10 x 200 ms, then falls back to 1457. | `bind_server`, `send_cancel_request`     |
| PKCE          | verifier = base64url-no-pad of 64 random bytes; challenge = base64url-no-pad(SHA-256(verifier)); `code_challenge_method=S256`                                                                                                                                                   | `login/src/pkce.rs`                      |
| `state`       | base64url-no-pad of 32 random bytes (`generate_state`). Callback state must equal it, or equal it with suffix `.onboarding_entrypoint=life_sciences` (`login_callback_result_from_state` in `callback_params.rs`).                                                              | `server.rs`, `callback_params.rs`        |

Full authorize query, in the order Codex emits it (`build_authorize_url`):

```
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri=http://localhost:1455/auth/callback
scope=openid profile email offline_access api.connectors.read api.connectors.invoke
code_challenge=<S256 challenge>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
state=<random>
originator=<originator, default codex_cli_rs>
allowed_workspace_id=<id1,id2>        # only when forced_chatgpt_workspace_id is configured
```

`originator()` comes from `login/src/auth/default_client.rs` (`DEFAULT_ORIGINATOR = "codex_cli_rs"`,
override env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`).

Callback handling (`process_request`, path `/auth/callback`):

- Query `error` / `error_description` are surfaced; `error=access_denied` with a description
  containing `missing_codex_entitlement` is rendered as "Codex is not enabled for your workspace"
  (`is_missing_codex_entitlement_error`).
- With a valid `code` and `state`, Codex calls `exchange_code_for_tokens`, then optionally
  `ensure_workspace_allowed` (compares the id_token claim `chatgpt_account_id` to the allow-list),
  then `obtain_api_key` (see below), then `persist_tokens_async`, then redirects to a local
  `/success` page (or a hosted page; `success_page.rs`).

Token endpoint (`exchange_code_for_tokens`):

```
POST {issuer}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<redirect_uri>&client_id=<client_id>&code_verifier=<verifier>
```

Response fields Codex deserializes (`struct TokenResponse`): `id_token`, `access_token`,
`refresh_token` (all required strings). Codex does not read `expires_in`; it derives access-token
expiry from the JWT `exp` claim (`parse_jwt_expiration`, `token_data.rs`). opencode reads an
optional `expires_in` and defaults to 3600 s (`codex.ts`, `interface TokenResponse`). Whether the
server always returns `expires_in`: **unverified**.

Error bodies from the token endpoint are parsed by `parse_token_endpoint_error`: either
`{"error":"<code>","error_description":"..."}` or `{"error":{"code":"...","message":"..."}}`.

Additional token exchange for an API key (`obtain_api_key`, RFC 8693 token exchange):

```
POST {issuer}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&client_id=<client_id>
&requested_token=openai-api-key
&subject_token=<id_token>
&subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

Response: `{"access_token": "<api key>"}`; stored as `OPENAI_API_KEY` in `auth.json`. When it is
used: only in the browser flow, and failure is ignored (`.ok()`); the device-code flow passes
`api_key: None`. The persisted record sets `auth_mode: Some(AuthMode::Chatgpt)`, and
`AuthDotJson::resolved_mode()` returns the explicit `auth_mode` first, so the presence of
`OPENAI_API_KEY` does not switch inference to API-key mode; inference still goes to the ChatGPT
backend with the access token (`manager.rs:1753-1770`, `CodexAuth::get_token`). What the
exchanged API key is used for elsewhere in the CLI: **unverified** (not needed for a provider).

## 2. Device-code (headless) flow

Yes. `codex login --device-auth` (`codex-rs/cli/src/login.rs:118`, `run_login_with_device_code`)
calls `run_device_code_login` in `codex-rs/login/src/device_code_auth.rs`. It is not RFC 8628; it
is an OpenAI-specific two-step API under `{issuer}/api/accounts`.

Step 1, `request_user_code`:

```
POST {issuer}/api/accounts/deviceauth/usercode
Content-Type: application/json

{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}
```

Response (`struct UserCodeResp`): `{"device_auth_id": "...", "user_code": "...", "interval": "5"}`.
`user_code` also accepts alias `usercode`; `interval` is a string that is parsed to seconds.
HTTP 404 means "device code login is not enabled for this Codex server".

The user is told to open `{issuer}/codex/device` and enter `user_code` (expires in 15 minutes per
the prompt text).

Step 2, `poll_for_token`:

```
POST {issuer}/api/accounts/deviceauth/token
Content-Type: application/json

{"device_auth_id": "...", "user_code": "..."}
```

- HTTP 403 or 404: not yet authorized; sleep `interval` seconds and retry; give up after 15 minutes
  (`max_wait`). opencode adds a 3 s safety margin to the interval (`OAUTH_POLLING_SAFETY_MARGIN_MS`).
- Any other non-2xx: fail.
- 2xx (`struct CodeSuccessResp`): `{"authorization_code": "...", "code_challenge": "...", "code_verifier": "..."}`.

Step 3: the normal authorization-code exchange (`exchange_code_for_tokens`) with
`redirect_uri = {issuer}/deviceauth/callback` and the server-supplied `code_verifier`. Then
`ensure_workspace_allowed` and `persist_tokens_async` with `api_key: None`.

## 3. Deriving the ChatGPT account id and plan type

`codex-rs/login/src/token_data.rs` (`parse_chatgpt_jwt_claims`, `struct IdClaims`, `struct AuthClaims`):
the id_token payload (base64url, no signature verification) is read for

- top-level `email`, falling back to `"https://api.openai.com/profile"."email"`;
- namespaced object `"https://api.openai.com/auth"` with fields
  `chatgpt_plan_type`, `chatgpt_user_id` (fallback `user_id`), `chatgpt_account_id`,
  `chatgpt_account_is_fedramp` (bool, default false).

At login, `persist_tokens_async` (`server.rs`) sets `tokens.account_id` from
`jwt_auth_claims(&id_token)["chatgpt_account_id"]`, where `jwt_auth_claims`
(`success_page.rs:106`) returns the `"https://api.openai.com/auth"` object of the **id_token**.
`CodexAuth::get_account_id()` (`manager.rs:584`) returns that stored `account_id`.

opencode (`codex.ts`, `extractAccountId`, `extractAccountIdFromClaims`) tries the id_token first,
then the access_token, and accepts `claims.chatgpt_account_id`, then
`claims["https://api.openai.com/auth"].chatgpt_account_id`, then `claims.organizations[0].id`.
Whether the access_token carries the same namespaced claim: **unverified** in Codex code (Codex
only reads `exp` from the access token); opencode's fallback suggests it does.

opencode also reads `"https://api.openai.com/auth".chatgpt_compute_residency` (or top-level) from
the access token and, unless it is `no_constraint`, sends it as
`x-openai-internal-codex-residency` (`extractResidency`). Codex names the same header
`RESIDENCY_HEADER_NAME` in `default_client.rs` and only sets it to `us` from config.

Plan type: `codex-rs/protocol/src/auth.rs`, `PlanType::from_raw_value` (case-insensitive):
`free`, `go`, `plus`, `pro`, `prolite`, `team`, `self_serve_business_prolite`,
`self_serve_business_usage_based`, `business`, `ent26`, `enterprise_cbp_automation`,
`enterprise_cbp_usage_based`, `enterprise` | `hc`, `education` | `edu`, `edu_plus`, `edu_pro`;
anything else becomes `PlanType::Unknown(String)`. `KnownPlan::is_workspace_account()` is true for
team/business/enterprise/edu variants. Codex does not gate inference on plan type client-side; the
backend answers with `usage_not_included` / `usage_limit_reached` (section 8).

## 4. Token refresh

`codex-rs/login/src/auth/manager.rs`: `request_chatgpt_token_refresh`, `persist_tokens`,
`should_refresh_proactively`, `refresh_and_persist_chatgpt_token`.

```
POST https://auth.openai.com/oauth/token        # REFRESH_TOKEN_URL; env override CODEX_REFRESH_TOKEN_URL_OVERRIDE
Content-Type: application/json

{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "grant_type": "refresh_token", "refresh_token": "<refresh_token>"}
```

Note the content type: Codex sends JSON for refresh but form-urlencoded for the code exchange.
opencode sends the refresh as form-urlencoded (`grant_type`, `refresh_token`, `client_id`) and
works, so the endpoint accepts both; no `scope` parameter is sent by either.

Response (`struct RefreshResponse`): `{"id_token"?: string, "access_token"?: string, "refresh_token"?: string}`;
every field optional; whichever fields are present replace the stored ones and `last_refresh` is
set to now (`persist_tokens`). Treat the refresh token as rotating: the server may return a new one
and the error code `refresh_token_reused` exists.

Refresh threshold (`should_refresh_proactively`):

1. If the stored `access_token` JWT has an `exp`, refresh when `exp <= now + 5 minutes`
   (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`).
2. Otherwise refresh when `last_refresh < now - 8 days` (`TOKEN_REFRESH_INTERVAL = 8`).

Reactive refresh: a 401 from the backend triggers one refresh-and-retry
(`core/src/client.rs:2314` doc comment "Handles a 401 response by optionally refreshing ChatGPT
tokens once", `handle_unauthorized`, `UnauthorizedRecoveryStep::RefreshToken`).

Failure classification (`classify_refresh_token_failure`, `extract_refresh_token_error_code`):
error code read from `error.code`, `error` (string), or top-level `code`. Permanent (re-login
required): `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, any HTTP
401, or HTTP 400 with `invalid_grant`. Everything else is transient.

## 5. On-disk auth storage

`codex-rs/login/src/auth/storage.rs`: `get_auth_file` = `<codex_home>/auth.json`; the struct
docstring says "Expected structure for $CODEX_HOME/auth.json". `codex_home` defaults to `~/.codex`
(the provider registry comment in `model-provider-info/src/lib.rs` refers to `~/.codex/config.toml`).

`AuthDotJson` (serialized with `serde_json::to_string_pretty`):

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": "sk-...or null",
  "tokens": {
    "id_token": "<raw JWT>",
    "access_token": "<raw JWT>",
    "refresh_token": "<opaque>",
    "account_id": "<chatgpt_account_id or null>"
  },
  "last_refresh": "2026-09-01T12:34:56.789Z"
}
```

- `auth_mode` values (`protocol/src/auth.rs`, `AuthMode`): `apikey`, `chatgpt`,
  `chatgptAuthTokens`, `headers`, `agentIdentity`, `personalAccessToken`, `bedrockApiKey`,
  `bedrockAccessKeys`. Optional; when absent `resolved_mode()` infers from which fields are set
  (`personal_access_token` > `bedrock_*` > `OPENAI_API_KEY` present => `apikey` > else `chatgpt`).
- `OPENAI_API_KEY` is always written (as `null` when absent); the other keys are omitted when
  `None` (`skip_serializing_if`). Extra optional keys that may appear: `agent_identity`,
  `personal_access_token`, `bedrock_api_key`, `bedrock_access_keys`.
- `tokens.id_token` is stored as the raw JWT string and parsed on read (`deserialize_id_token`).
- `last_refresh` is an RFC 3339 UTC timestamp (`chrono::DateTime<Utc>`).
- File mode `0o600` on Unix (`FileAuthStorage::save`, `OpenOptions::mode(0o600)`), written with
  truncate+create (not atomic rename).

Reusing an existing Codex login by reading this file:

- Stable enough: the `tokens.{id_token,access_token,refresh_token,account_id}` shape and
  `OPENAI_API_KEY` key have been additive-only, and the reader tolerates missing optional fields.
  `get_token_data()` requires both `tokens` and `last_refresh` to be present.
- Caveat 1: Codex may store credentials in the OS keyring instead of the file
  (`AuthCredentialsStoreMode`, `DirectKeyringAuthStorage`; keyring service `"Codex Auth"`, key
  `cli|<first 16 hex of sha256(canonical codex_home)>`, secret name `CODEX_AUTH`). In that mode
  `auth.json` may not exist.
- Caveat 2: refresh tokens rotate. If magentic refreshes using a token read from `auth.json` and
  does not write the new one back, the Codex CLI's copy becomes stale (`refresh_token_reused`).
  Either write back in the same shape (Codex rewrites the whole file, so a foreign writer must
  preserve unknown keys) or copy the tokens once into magentic's own store and let the two logins
  diverge. opencode chooses the latter (it never reads `~/.codex/auth.json`).

## 6. Inference API with subscription auth

Base URL selection: `codex-rs/model-provider-info/src/lib.rs`,
`pub const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex"`, used by
`ModelProviderInfo::to_api_provider` whenever `auth_mode` is `Chatgpt`, `ChatgptAuthTokens`,
`Headers`, `AgentIdentity` or `PersonalAccessToken`; otherwise `https://api.openai.com/v1`.
Only the Responses wire API exists (`WireApi::Responses`; `chat` was removed).

Path: `/responses` (`codex-api/src/endpoint/responses.rs`, `ResponsesEndpoint::Responses::path()`),
so the full URL is `https://chatgpt.com/backend-api/codex/responses`. Sibling routes on the same
base: `/responses/compact`, `/models`, `/guardian`, `/guardian-classifier`, `/memories/trace_summarize`,
`/realtime/calls` (`core/src/client.rs` constants).

Request headers (who sets them):

| Header                                                                                                                                                                                                                                                                            | Value                                                                                                                                                           | Source                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`                                                                                                                                                                                                                                                                   | `Bearer <access_token>`                                                                                                                                         | `model-provider/src/bearer_auth_provider.rs` (`BearerAuthProvider::add_auth_headers`), chosen for `CodexAuth::Chatgpt` by `auth_provider_from_auth` (`model-provider/src/auth.rs:307`) with `token = get_token()` = `tokens.access_token` |
| `ChatGPT-Account-ID`                                                                                                                                                                                                                                                              | `tokens.account_id`                                                                                                                                             | same (`account_id: auth.get_account_id()`)                                                                                                                                                                                                |
| `X-OpenAI-Fedramp`                                                                                                                                                                                                                                                                | `true` only when `chatgpt_account_is_fedramp`                                                                                                                   | same                                                                                                                                                                                                                                      |
| `originator`                                                                                                                                                                                                                                                                      | `codex_cli_rs` (default)                                                                                                                                        | `default_client.rs` `default_headers()`; the Responses transport is built by `create_client_for_route` which uses `default_http_client_builder().default_headers(default_headers())` (`core/src/client.rs:1130`)                          |
| `User-Agent`                                                                                                                                                                                                                                                                      | `"{originator}/{version} ({os_type} {os_version}; {arch}) {terminal user agent}"` e.g. `codex_cli_rs/0.144.0 (Mac OS 15.5; arm64) ...` (`get_codex_user_agent`) | `default_client.rs`                                                                                                                                                                                                                       |
| `version`                                                                                                                                                                                                                                                                         | Codex `CARGO_PKG_VERSION`                                                                                                                                       | `ModelProviderInfo::create_openai_provider` `http_headers`                                                                                                                                                                                |
| `Accept`                                                                                                                                                                                                                                                                          | `text/event-stream`                                                                                                                                             | `endpoint/responses.rs` `stream_encoded`                                                                                                                                                                                                  |
| `Content-Type`                                                                                                                                                                                                                                                                    | `application/json` (body may be zstd-compressed with `Compression::Zstd`)                                                                                       | `codex_client::EncodedJsonBody`                                                                                                                                                                                                           |
| `session-id`, `thread-id`                                                                                                                                                                                                                                                         | session UUID, thread UUID                                                                                                                                       | `codex-api/src/requests/headers.rs` `build_session_headers`                                                                                                                                                                               |
| `x-client-request-id`                                                                                                                                                                                                                                                             | thread id                                                                                                                                                       | `endpoint/responses.rs`                                                                                                                                                                                                                   |
| `x-codex-installation-id`, `x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`, `x-codex-beta-features`, `x-codex-routing-hint`, `x-openai-subagent`, `x-oai-attestation`, `x-openai-internal-codex-responses-lite`, `x-responsesapi-include-timing-metrics` | Codex-internal telemetry / routing                                                                                                                              | `core/src/client.rs`, `core/src/responses_metadata.rs`                                                                                                                                                                                    |
| `x-codex-turn-state`                                                                                                                                                                                                                                                              | Sticky-routing token: read from the response header of the first request in a turn and replayed on later requests in that turn                                  | `core/src/client.rs:309-323`, `build_responses_headers`                                                                                                                                                                                   |
| `OpenAI-Beta`                                                                                                                                                                                                                                                                     | `responses_websockets=2026-02-06`; set only on the WebSocket path (`client.rs:1260`), not on HTTP `/responses`                                                  | `core/src/client.rs`                                                                                                                                                                                                                      |

The minimal set a third-party client actually needs is **unverified** from the code alone; opencode
sends only `authorization`, `ChatGPT-Account-Id`, `originator`, `User-Agent`, `session-id`, the
optional residency header, and standard `Content-Type`/`Accept` from the AI SDK, and works.

Request body (`codex-api/src/common.rs` `ResponsesApiRequest`, populated by
`core/src/client.rs` `build_responses_request`):

```jsonc
{
  "model": "gpt-5.5", // model slug
  "instructions": "...", // omitted if empty; Codex puts its base prompt here (or, for use_responses_lite models, as developer input items)
  "input": [/* ResponseItem[] */],
  "tools": [/* Responses-API tool objects, incl. function tools */], // omitted if None
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto", "context": "all_turns" }, // effort/summary/context each optional
  "store": false, // always false
  "stream": true, // always true
  "stream_options": { "reasoning_summary_delivery": "sequential_cutoff" }, // optional, OpenAI only
  "include": ["reasoning.encrypted_content"], // always
  "service_tier": "priority", // optional ("Fast"); from models.json service_tiers
  "prompt_cache_key": "<session id>", // always set (session id, or override)
  "text": {
    "verbosity": "medium",
    "format": {
      "type": "json_schema",
      "strict": true,
      "schema": {},
      "name": "codex_output_schema",
    },
  }, // optional
  "client_metadata": {
    "x-codex-installation-id": "...",
    "session_id": "...",
    "thread_id": "...",
    "x-codex-window-id": "...",
  }, // optional map
  "access_programs": { "cyber": "standard" }, // optional
}
```

Constraints relative to the public Responses API, as far as the code shows:

- `stream: true` and `store: false` are hard-coded (`client.rs:1022-1023`); opencode also forces
  `store: false` (`transform.ts` `smallOptions`). Whether the backend rejects `store: true` or
  non-streaming: **unverified** (never exercised).
- `temperature`, `max_output_tokens`, `top_p`, `previous_response_id` (HTTP), `metadata`, `user`
  do not exist on `ResponsesApiRequest`, so Codex never sends them. opencode explicitly sets
  `maxOutputTokens = undefined` with the comment "Match codex cli" (`codex.ts`, `chat.params`),
  which is the only hint that the backend dislikes `max_output_tokens`. Rejection behaviour:
  **unverified**.
- `include` is always `["reasoning.encrypted_content"]` so that reasoning items can be replayed
  across turns without `store`.
- `reasoning.effort` values come from the catalog `supported_reasoning_levels`
  (`low|medium|high|xhigh|max|ultra` depending on model, section 7); `reasoning.summary` values are
  the protocol `ReasoningSummary` enum (`auto`, `concise`, `detailed`, `none`; **unverified** which
  the backend accepts beyond `auto`); `text.verbosity` is `low|medium|high`
  (`OpenAiVerbosity`).
- Tools are standard Responses-API tool JSON serialized as a raw value
  (`create_tools_raw_json_for_responses_api`); the local shell / apply_patch tools are ordinary
  function tools from the wire's point of view (**unverified** for the `code_mode_only` models,
  which use `use_responses_lite` and put tools in an `additional_tools` developer item).
- Input items use `codex_protocol::models::ResponseItem`, e.g.
  `{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}`,
  `{"type":"function_call", ...}`, `{"type":"function_call_output","call_id":"...","output":"..."}`,
  `{"type":"reasoning", "encrypted_content": "..."}` (`protocol/src/models.rs`).
- Request bodies may be zstd-compressed (`Compression::Zstd`, `client.rs:1540`); plain JSON is the
  default.

Response: SSE (`codex-api/src/sse/responses.rs`, `process_sse`). The event names are the
standard Responses API streaming events. Codex handles:

- `response.created`
- `response.output_item.added`, `response.output_item.done` (full `ResponseItem`)
- `response.output_text.delta`
- `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta`,
  `response.reasoning_summary_text.done`, `response.reasoning_text.delta`
- `response.custom_tool_call_input.delta`
- `response.completed` with `response.id`, `response.usage` (`input_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`,
  `total_tokens`), optional `usage_metadata`, optional `end_turn`
- `response.failed` with `response.error.{type,code,message,plan_type,resets_at,misalignment}`
- `response.incomplete` with `response.incomplete_details.reason`
- ignored: `response.in_progress`, `response.content_part.added/done`,
  `response.function_call_arguments.delta/done`, `response.custom_tool_call_input.done`,
  `response.output_text.done`, `response.reasoning_summary_part.done`, `response.metadata`

Response headers Codex reads: `x-codex-turn-state` (sticky routing), `OpenAI-Model` (actual model
served, may differ), `X-Reasoning-Included`, `x-request-id`, `cf-ray`, plus the rate-limit family in
section 8. A `codex.rate_limits` JSON event also exists (`parse_rate_limit_event`) and is delivered
on the WebSocket transport; **unverified** whether it appears on HTTP SSE.

## 7. Models accepted by the subscription endpoint

Codex no longer hardcodes presets ("Hardcoded model presets were removed; model listings are now
derived from the active catalog", `models-manager/src/model_presets.rs`). Sources, in order:

1. Bundled catalog `codex-rs/models-manager/models.json` (loaded by `load_remote_models_from_file`).
2. Remote `GET {base_url}/models?client_version=<codex version>` on the same base URL as inference
   (`codex-api/src/endpoint/models.rs`, `ModelsClient`), authenticated with the same
   `Authorization`/`ChatGPT-Account-ID` headers, with `ETag` caching; response
   `{"models": [ModelInfo, ...]}` (`protocol/src/openai_models.rs`). Cached in
   `<codex_home>/models_cache.json` for 300 s (`MODEL_CACHE_FILE`, `DEFAULT_MODEL_CACHE_TTL`).
3. `ModelPreset::filter_by_auth(models, chatgpt_mode)`: in ChatGPT mode every catalog model is
   offered; in API-key mode only `supported_in_api == true`.

Slugs in the bundled `models.json` at this commit (all have `supported_in_api: true`, so slugs are
identical between the subscription backend and the public API):

| slug                       | picker visibility | reasoning efforts (default)                | `use_responses_lite`              | plans (subset)                                        | min client |
| -------------------------- | ----------------- | ------------------------------------------ | --------------------------------- | ----------------------------------------------------- | ---------- |
| `gpt-5.6-sol`              | list              | low, medium, high, xhigh, max, ultra (low) | true, `tool_mode: code_mode_only` | free, go, plus, pro, team, business, enterprise, edu  | 0.144.0    |
| `gpt-5.6-terra`            | list              | low..ultra (medium)                        | true                              | same                                                  | 0.144.0    |
| `gpt-5.6-luna`             | list              | low..max (medium)                          | true                              | same                                                  | 0.144.0    |
| `gpt-daybreak-blue-latest` | hide              | low..ultra (low)                           | true                              | same                                                  | 0.142.2    |
| `gpt-daybreak-red-latest`  | hide              | low..ultra (medium)                        | true                              | same                                                  | 0.142.2    |
| `gpt-5.5`                  | list              | low, medium, high, xhigh (medium)          | false                             | same incl. free                                       | 0.124.0    |
| `gpt-5.4`                  | hide              | low..xhigh (medium)                        | false                             | plus, pro, team, business, enterprise, edu (not free) | 0.98.0     |
| `gpt-5.4-mini`             | hide              | low..xhigh (medium)                        | false                             | incl. free                                            | 0.98.0     |
| `gpt-5.2`                  | hide              | low..xhigh (medium)                        | false                             | incl. free                                            | 0.0.1      |
| `codex-auto-review`        | hide              | low..max (medium)                          | true                              | not free                                              | 0.98.0     |

`gpt-5`, `gpt-5-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`,
`gpt-5.3-codex` are not in the bundled catalog at this commit (only migration-prompt keys and a
`gpt-5.2-codex` message mapping remain in `models-manager/src/model_info.rs`). Whether the backend
still serves them: **unverified**; the remote `/models` response is authoritative and should be
fetched at runtime rather than hardcoded. `context_window` is 272000 for all bundled models
except `gpt-daybreak-red-latest` (372000). Models with `use_responses_lite: true` require the
"responses lite" request shape (base instructions and tools as developer input items and the
`x-openai-internal-codex-responses-lite: true` header, `core/src/client.rs` `add_responses_lite_header`);
prefer the non-lite models (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`) for a first
implementation.

opencode's allow-list (`codex.ts`): `ALLOWED_MODELS = {gpt-5.5, gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini}`,
`DISALLOWED_MODELS = {gpt-5.5-pro}`, `gpt-5.6` excluded, any `gpt-<x.y>` with `x.y > 5.4` allowed,
`reasoningMode === "pro"` excluded; model metadata itself comes from models.dev's `openai`
provider (`provider.ts` imports `ModelsDev`).

## 8. Rate-limit headers, usage endpoints, error shapes

Headers on `/responses` responses (`codex-api/src/rate_limits.rs`, `parse_rate_limit_for_limit`,
`parse_credits_snapshot`, `parse_promo_message`, `parse_rate_limit_reached_type`;
`api_bridge.rs` `ACTIVE_LIMIT_HEADER`):

- `x-codex-primary-used-percent` (f64), `x-codex-primary-window-minutes` (i64),
  `x-codex-primary-reset-at` (unix seconds)
- `x-codex-secondary-used-percent`, `x-codex-secondary-window-minutes`, `x-codex-secondary-reset-at`
- Additional limit families use prefix `x-<limit-id>-...` (e.g. `x-codex-bengalfox-primary-used-percent`)
  plus `x-<limit-id>-limit-name`; the active one is named in `x-codex-active-limit`
- `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-credits-balance`
- `x-codex-promo-message`, `x-codex-rate-limit-reached-type`

Usage endpoints (`codex-rs/backend-client/src/client.rs`, `client/rate_limit_resets.rs`; ChatGPT
path style when base URL contains `/backend-api`): `GET https://chatgpt.com/backend-api/wham/usage`
(rate-limit status and reset credits), `GET .../wham/accounts/check`, `GET .../wham/profiles/me`,
sent with the same bearer + `ChatGPT-Account-Id` headers and `User-Agent`. Payload structs are in
`backend-client/src/types.rs` (`RateLimitStatusWithResetCredits`, `AccountsCheckResponse`).

HTTP error handling (`codex-api/src/api_bridge.rs` `map_api_error`, `codex-client/src/retry.rs`):

- `401`: refresh tokens once, retry (section 4).
- `429` with body `{"error": {"type": "usage_limit_reached", "plan_type": "plus", "resets_at": 1704074400}}`
  becomes `CodexErr::UsageLimitReached` (also reads the headers above); body type
  `usage_not_included` becomes `CodexErr::UsageNotIncluded`; any other 429 is `RetryLimit`.
  Codex's retry policy has `retry_429: false`, `retry_5xx: true`, `max_attempts = 4`, base delay
  200 ms (`model-provider-info/src/lib.rs` `to_api_provider`).
- `400` with `error.code == "cyber_policy"` or "invalid image" text is special-cased; otherwise
  `InvalidRequest(body)`.
- `500` is `InternalServerError`; other statuses are `UnexpectedStatus`.

In-stream errors (`response.failed`, `sse/responses.rs`) by `error.code`:
`context_length_exceeded`, `insufficient_quota`, `usage_not_included`, `cyber_policy`,
`misalignment_policy_violation`, `invalid_prompt` | `bio_policy`, `server_is_overloaded`,
`rate_limit_exceeded` (message like "Please try again in 11.054s" is parsed for a delay by
`try_parse_retry_after`); anything else is treated as retryable.

## 9. How opencode implements it

File: `packages/opencode/src/plugin/openai/codex.ts` (`CodexAuthPlugin`), registered as a built-in
plugin in `packages/opencode/src/plugin/index.ts` (`internalPlugins`). Optional WebSocket
transport in `plugin/openai/ws.ts` / `ws-pool.ts` (`PROTOCOL_HEADER = "responses_websockets=2026-02-06"`).

- Does not read `~/.codex/auth.json` (no reference anywhere under `packages/opencode/src`). It runs
  its own flows and stores the result in opencode's `auth.json`
  (`packages/opencode/src/auth/index.ts`: `path.join(Global.Path.data, "auth.json")`, mode 0o600,
  or env `OPENCODE_AUTH_CONTENT`) under key `openai` as
  `{type: "oauth", refresh, access, expires: epoch ms, accountId?}` (`Oauth` schema class).
- Browser flow: same `client_id`, same issuer, `/oauth/authorize` with
  `scope = "openid profile email offline_access"` (no connectors scopes),
  `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=opencode`;
  local server on fixed port 1455 (`OAUTH_PORT`, no 1457 fallback) at `/auth/callback`; PKCE
  verifier is 43 chars from the unreserved alphabet; 5-minute callback timeout. It skips the
  id_token-to-API-key exchange.
- Headless flow: identical device-code endpoints (`/api/accounts/deviceauth/usercode`,
  `/api/accounts/deviceauth/token`, verification URL `/codex/device`, redirect
  `/deviceauth/callback`), polling `interval + 3 s`.
- Refresh: form-urlencoded `grant_type=refresh_token` when `expires < Date.now()` (no proactive
  window), de-duplicated with a shared promise, then `auth.set` with the new tokens and
  `expires = now + (expires_in ?? 3600) s`.
- Request patching: the provider is created with `apiKey: OAUTH_DUMMY_KEY` and a custom `fetch`.
  The wrapper deletes any incoming `Authorization`, sets `authorization: Bearer <access>`,
  `ChatGPT-Account-Id`, and if the request path contains `/v1/responses` or `/chat/completions`
  rewrites the URL to `https://chatgpt.com/backend-api/codex/responses`
  (`CODEX_API_ENDPOINT`) and adds `x-openai-internal-codex-residency` when the access token
  carries a residency claim. The `chat.headers` hook adds `originator: opencode`,
  `User-Agent: opencode/<version> (<platform> <release>; <arch>)`, and `session-id: <sessionID>`.
  The `chat.params` hook sets `maxOutputTokens = undefined`. `provider/transform.ts` supplies
  `store: false`, `promptCacheKey = sessionID`, `reasoningSummary: "auto"`,
  `include: ["reasoning.encrypted_content"]` for `@ai-sdk/openai` models.
- Models exposed: see section 7; cost is zeroed and `gpt-5.5`/`gpt-5.6` limits are overridden to
  `{context: 400000, input: 272000, output: 128000}`.

## 10. Terms-of-service / usage-policy statements in the openai/codex repo

Nothing in the repository states a policy about third-party clients using the ChatGPT-subscription
endpoint. What the repo does say:

- `README.md` ("Using Codex with your ChatGPT plan"): "We recommend signing into your ChatGPT
  account to use Codex as part of your Plus, Pro, Business, Edu, or Enterprise plan", linking to
  `https://help.openai.com/en/articles/11369540-codex-in-chatgpt` (not consulted).
- `docs/authentication.md` only links to `https://developers.openai.com/codex/auth`.
- License is Apache-2.0 (`LICENSE`, `docs/license.md`), which covers the code, not the service.
- The client identifies itself via `originator` and `User-Agent`;
  `is_first_party_originator` (`default_client.rs`) recognises `codex_cli_rs`, `codex-tui`,
  `codex_vscode`, and `Codex *`. Whether the backend enforces anything on these values:
  **unverified**. opencode sends `originator: opencode` and works, which suggests no
  allow-list on that header at the time of writing.
- The `access_denied` / `missing_codex_entitlement` OAuth error and the `usage_not_included`
  backend error are the only entitlement checks visible in the code.

Operational conclusion: the repo neither authorizes nor prohibits third-party use; the governing
terms live in OpenAI's ChatGPT/Codex usage policies outside the repo. Treat this as an
"unofficial, may break" integration and keep an API-key provider as the supported path.

---

## Minimal streaming request (curl), assembled only from the sources above

Inputs: `$ACCESS_TOKEN` = `tokens.access_token` from `~/.codex/auth.json` (or a fresh refresh),
`$ACCOUNT_ID` = `tokens.account_id`. Headers beyond `Authorization`, `ChatGPT-Account-ID`,
`Content-Type` and `Accept` are what Codex/opencode send; which of them the backend requires is
unverified, so they are included.

```sh
curl -N https://chatgpt.com/backend-api/codex/responses \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "ChatGPT-Account-ID: $ACCOUNT_ID" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "originator: codex_cli_rs" \
  -H "User-Agent: codex_cli_rs/0.144.0 (Mac OS 15.5; arm64)" \
  -H "session-id: $(uuidgen)" \
  --data-binary @- <<'JSON'
{
  "model": "gpt-5.5",
  "instructions": "You are a helpful assistant.",
  "input": [
    { "type": "message", "role": "user",
      "content": [ { "type": "input_text", "text": "Say hello in one sentence." } ] }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "00000000-0000-4000-8000-000000000000"
}
JSON
```

Expected stream: `event`-less SSE `data:` lines whose JSON `type` runs through `response.created`,
`response.output_item.added`, `response.output_text.delta` ..., `response.output_item.done`,
`response.completed` (with `response.usage`), or `response.failed` with `response.error.code`.

Token refresh, for completeness:

```sh
curl https://auth.openai.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"'"$REFRESH_TOKEN"'"}'
# -> {"id_token": "...", "access_token": "...", "refresh_token": "..."}   (each field optional)
```

## Implementation notes for magentic (derived, not sourced)

- Model the auth as its own service with a `reason` union error (`RefreshExpired`,
  `RefreshReused`, `RefreshRevoked`, `Transient`, `NotLoggedIn`) mirroring
  `RefreshTokenFailedReason`; proactively refresh at `exp - 5 min`; on 401 refresh once and retry.
- Persist to magentic's own store; optionally import from `~/.codex/auth.json` once, do not share
  the refresh token with the CLI.
- Use Effect's `effect/unstable/ai` OpenAI Responses client with `baseUrl =
https://chatgpt.com/backend-api/codex`, force `stream: true`, `store: false`,
  `include: ["reasoning.encrypted_content"]`, drop `max_output_tokens`/`temperature`, and inject
  the headers above; replay `x-codex-turn-state` within a turn.
- Fetch `/models?client_version=...` at startup (cache 5 min) rather than hardcoding slugs.

## Sources

openai/codex @ `612e6491d50ffb80ffc4330edc4024b86e51e4bf` (https://github.com/openai/codex/tree/612e6491d50ffb80ffc4330edc4024b86e51e4bf)

- `codex-rs/login/src/server.rs` (`DEFAULT_ISSUER`, `DEFAULT_PORT`, `FALLBACK_PORT`, `run_login_server`, `build_authorize_url`, `generate_state`, `bind_server`, `process_request`, `exchange_code_for_tokens`, `obtain_api_key`, `persist_tokens_async`, `ensure_workspace_allowed`, `parse_token_endpoint_error`)
- `codex-rs/login/src/pkce.rs` (`generate_pkce`)
- `codex-rs/login/src/callback_params.rs` (`login_callback_result_from_state`)
- `codex-rs/login/src/device_code_auth.rs` (`request_user_code`, `poll_for_token`, `request_device_code`, `complete_device_code_login`)
- `codex-rs/login/src/token_data.rs` (`TokenData`, `IdTokenInfo`, `IdClaims`, `AuthClaims`, `parse_chatgpt_jwt_claims`, `parse_jwt_expiration`)
- `codex-rs/login/src/token_data_tests.rs` (claim fixtures)
- `codex-rs/login/src/success_page.rs` (`jwt_auth_claims`)
- `codex-rs/login/src/auth/manager.rs` (`CLIENT_ID`, `CLIENT_ID_OVERRIDE_ENV_VAR`, `REFRESH_TOKEN_URL`, `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR`, `TOKEN_REFRESH_INTERVAL`, `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`, `request_chatgpt_token_refresh`, `RefreshRequest`, `RefreshResponse`, `persist_tokens`, `classify_refresh_token_failure`, `should_refresh_proactively`, `CodexAuth::get_token`, `get_account_id`, `AuthDotJson::resolved_mode`)
- `codex-rs/login/src/auth/storage.rs` (`AuthDotJson`, `get_auth_file`, `FileAuthStorage::save`, keyring storage)
- `codex-rs/login/src/auth/default_client.rs` (`DEFAULT_ORIGINATOR`, `RESIDENCY_HEADER_NAME`, `originator`, `get_codex_user_agent`, `default_headers`, `create_client_for_route`, `is_first_party_originator`)
- `codex-rs/login/src/auth/auth_tests.rs` (auth.json fixtures)
- `codex-rs/protocol/src/auth.rs` (`AuthMode`, `PlanType`, `KnownPlan`, `RefreshTokenFailedReason`)
- `codex-rs/protocol/src/models.rs` (`ResponseItem`, `ContentItem`)
- `codex-rs/protocol/src/openai_models.rs` (`ModelInfo`, `ModelPreset::filter_by_auth`)
- `codex-rs/model-provider-info/src/lib.rs` (`CHATGPT_CODEX_BASE_URL`, `to_api_provider`, `create_openai_provider`, retry config)
- `codex-rs/model-provider/src/auth.rs` (`auth_provider_from_auth`, `AuthManagerAuthProvider`)
- `codex-rs/model-provider/src/bearer_auth_provider.rs` (`BearerAuthProvider::add_auth_headers`)
- `codex-rs/model-provider/src/models_endpoint.rs` (`OpenAiModelsEndpoint::list_models`)
- `codex-rs/models-manager/models.json`, `codex-rs/models-manager/src/manager.rs`, `codex-rs/models-manager/src/model_presets.rs`
- `codex-rs/codex-api/src/common.rs` (`ResponsesApiRequest`, `Reasoning`, `TextControls`, `ResponseEvent`)
- `codex-rs/codex-api/src/endpoint/responses.rs` (`ResponsesEndpoint`, `stream_encoded`)
- `codex-rs/codex-api/src/endpoint/models.rs` (`ModelsClient`)
- `codex-rs/codex-api/src/requests/headers.rs` (`build_session_headers`)
- `codex-rs/codex-api/src/sse/responses.rs` (event dispatch, `Error`, `try_parse_retry_after`)
- `codex-rs/codex-api/src/rate_limits.rs` (header names, `parse_rate_limit_event`)
- `codex-rs/codex-api/src/api_bridge.rs` (`map_api_error`, `UsageErrorBody`, `ACTIVE_LIMIT_HEADER`)
- `codex-rs/codex-api/src/error.rs` (`ApiError`)
- `codex-rs/core/src/client.rs` (`build_responses_request`, header constants, `build_responses_headers`, `handle_unauthorized`, `build_api_transport`)
- `codex-rs/core/src/responses_metadata.rs` (`client_metadata`, `compatibility_headers`)
- `codex-rs/backend-client/src/client.rs`, `codex-rs/backend-client/src/client/rate_limit_resets.rs`, `codex-rs/backend-client/src/types.rs`
- `codex-rs/cli/src/login.rs` (`--device-auth`)
- `README.md`, `docs/authentication.md`, `docs/license.md`, `LICENSE`

anomalyco/opencode @ `8ff796f13373394499378697002327e222dcc8fa` (https://github.com/anomalyco/opencode/tree/8ff796f13373394499378697002327e222dcc8fa)

- `packages/opencode/src/plugin/openai/codex.ts` (`CLIENT_ID`, `ISSUER`, `CODEX_API_ENDPOINT`, `OAUTH_PORT`, `ALLOWED_MODELS`, `DISALLOWED_MODELS`, `generatePKCE`, `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshAccessToken`, `extractAccountId`, `extractResidency`, `CodexAuthPlugin`)
- `packages/opencode/src/plugin/openai/ws.ts` (`PROTOCOL_HEADER`), `packages/opencode/src/plugin/openai/README.md`
- `packages/opencode/src/plugin/index.ts` (`internalPlugins`)
- `packages/opencode/src/auth/index.ts` (`OAUTH_DUMMY_KEY`, `Oauth`, file path, 0o600)
- `packages/opencode/src/provider/transform.ts` (`INCLUDE_ENCRYPTED_REASONING`, `smallOptions`, cache key / reasoning options)
- `packages/opencode/src/provider/provider.ts` (models.dev import)
