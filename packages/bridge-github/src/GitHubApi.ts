import { createPrivateKey, sign } from "node:crypto";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Random,
  Redacted,
  Schema,
  Semaphore,
} from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()("GitHubApiError", {
  reason: Schema.Literals([
    "Unauthorized",
    "Forbidden",
    "NotFound",
    "RateLimited",
    "Validation",
    "Server",
    "Transport",
    "Decode",
    "NotModified",
  ]),
  status: Schema.Int,
  call: Schema.String,
  message: Schema.String,
}) {}

export type GitHubAuth =
  | { readonly _tag: "App" }
  | { readonly _tag: "Installation"; readonly installationId: number }
  | { readonly _tag: "Repository"; readonly owner: string; readonly repo: string }
  | { readonly _tag: "Token"; readonly token: Redacted.Redacted<string> };

export interface GitHubAppCredentials {
  readonly appId: number;
  readonly privateKey: Redacted.Redacted<string>;
}
export interface GitHubApiOptions {
  readonly apiUrl: string;
  readonly app: Option.Option<GitHubAppCredentials>;
  readonly userAgent: string;
}
export interface RequestOptions<A> {
  readonly body?: Schema.Json | undefined;
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly accept?: string | undefined;
  /**
   * Hand the body to the schema as text instead of parsed JSON, for answers
   * whose numbers exceed what `JSON.parse` keeps, such as webhook delivery
   * ids.
   */
  readonly raw?: boolean | undefined;
  readonly schema: Schema.Codec<A>;
}
export interface Answer<A> {
  readonly status: number;
  readonly body: A;
  readonly etag: Option.Option<string>;
  readonly lastModified: Option.Option<string>;
  readonly next: Option.Option<string>;
  /** The last page of a list, when GitHub paged it. */
  readonly last: Option.Option<string>;
}
export interface InstallationToken {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
}

interface CachedToken extends InstallationToken {
  readonly refreshAt: number;
}
interface RetryInfo {
  readonly retryAfter: Option.Option<string>;
  readonly reset: Option.Option<string>;
}
interface ErrorWords {
  readonly message: string;
  readonly details: string;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const retryInfo = new WeakMap<GitHubApiError, RetryInfo>();
const InstallationResponse = Schema.Struct({ id: Schema.Int });
const TokenResponse = Schema.Struct({ token: Schema.String, expires_at: Schema.String });
const ErrorResponse = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  ),
});
const GraphqlResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Json),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const failure = (
  reason: GitHubApiError["reason"],
  status: number,
  call: string,
  message: string,
): GitHubApiError => new GitHubApiError({ reason, status, call, message });

export const appJwt = Effect.fn("GitHubApi.appJwt")(function* (
  credentials: GitHubAppCredentials,
  nowMillis: number,
) {
  return yield* Effect.try({
    try: () => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          iat: Math.floor(nowMillis / 1_000) - 60,
          exp: Math.floor(nowMillis / 1_000) + 9 * 60,
          iss: credentials.appId,
        }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const key = createPrivateKey(Redacted.value(credentials.privateKey));
      return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    },
    catch: (error) =>
      failure(
        "Unauthorized",
        0,
        "POST /app/installations/{id}/access_tokens",
        `cannot sign GitHub App JWT: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
});

export const parseLinkHeader = (value: string): ReadonlyMap<string, string> => {
  const links = new Map<string, string>();
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      for (const rel of match[2].split(/\s+/)) links.set(rel, match[1]);
    }
  }
  return links;
};

const responseHeader = (response: HttpClientResponse.HttpClientResponse, name: string) =>
  Headers.get(response.headers, name);
const words = (json: Schema.Json): ErrorWords => {
  const decoded = Schema.decodeUnknownOption(ErrorResponse)(json);
  if (Option.isNone(decoded)) return { message: "", details: "" };
  return {
    message: decoded.value.message ?? "",
    details: (decoded.value.errors ?? [])
      .flatMap((entry) => (entry.message === undefined ? [] : [entry.message]))
      .join("; "),
  };
};
const reasonFor = (
  status: number,
  message: string,
  response: HttpClientResponse.HttpClientResponse,
): GitHubApiError["reason"] => {
  if (status === 304) return "NotModified";
  if (status === 401) return "Unauthorized";
  if (status === 403) {
    return Option.isSome(responseHeader(response, "retry-after")) ||
      Option.getOrUndefined(responseHeader(response, "x-ratelimit-remaining")) === "0" ||
      /rate limit|secondary/i.test(message)
      ? "RateLimited"
      : "Forbidden";
  }
  if (status === 404) return "NotFound";
  if (status === 422) return "Validation";
  if (status === 429) return "RateLimited";
  return status >= 500 ? "Server" : "Validation";
};

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    request<A>(
      auth: GitHubAuth,
      method: Method,
      path: string,
      options: RequestOptions<A>,
    ): Effect.Effect<Answer<A>, GitHubApiError>;
    graphql<A>(
      auth: GitHubAuth,
      query: string,
      variables: Readonly<Record<string, Schema.Json>>,
      schema: Schema.Codec<A>,
    ): Effect.Effect<A, GitHubApiError>;
    token(
      auth: Exclude<GitHubAuth, { _tag: "App" }>,
    ): Effect.Effect<InstallationToken, GitHubApiError>;
    forget(auth: GitHubAuth): Effect.Effect<void>;
  }
>()("magentic/bridge-github/GitHubApi") {
  static readonly layer = (
    options: GitHubApiOptions,
  ): Layer.Layer<GitHubApi, never, HttpClient.HttpClient> =>
    Layer.effect(
      GitHubApi,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        let jwt: { readonly value: string; readonly refreshAt: number } | undefined;
        const installations = new Map<string, number>();
        const tokens = new Map<string, CachedToken>();
        const locks = new Map<string, Semaphore.Semaphore>();
        const lockFor = (key: string) => {
          const found = locks.get(key);
          if (found !== undefined) return found;
          // Unsafe construction cannot suspend, so two fibers cannot install different locks.
          const made = Semaphore.makeUnsafe(1);
          locks.set(key, made);
          return made;
        };
        const noApp = (call: string) =>
          failure(
            "Unauthorized",
            0,
            call,
            "no GitHub App is configured; only Token authentication is available",
          );
        const currentJwt = Effect.fn("GitHubApi.jwt")(function* (call: string) {
          if (Option.isNone(options.app)) return yield* noApp(call);
          const now = yield* Clock.currentTimeMillis;
          if (jwt !== undefined && now < jwt.refreshAt) return jwt.value;
          const value = yield* appJwt(options.app.value, now);
          jwt = { value, refreshAt: now + 8 * 60_000 };
          return value;
        });

        const execute = Effect.fn("GitHubApi.execute")(function* <A>(
          bearer: string,
          method: Method,
          path: string,
          requestOptions: RequestOptions<A>,
        ) {
          const url = new URL(path, `${options.apiUrl.replace(/\/$/, "")}/`);
          for (const [key, value] of Object.entries(requestOptions.query ?? {})) {
            url.searchParams.set(key, value);
          }
          const call = `${method} ${url.pathname}`;
          let request = HttpClientRequest.make(method)(url).pipe(
            HttpClientRequest.setHeaders(requestOptions.headers ?? {}),
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${bearer}`,
              accept: requestOptions.accept ?? "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": options.userAgent,
            }),
          );
          if (requestOptions.body !== undefined) {
            request = yield* HttpClientRequest.bodyJson(request, requestOptions.body).pipe(
              Effect.mapError((error) =>
                failure("Transport", 0, call, `cannot encode request body: ${error.message}`),
              ),
            );
          }
          const response = yield* http
            .execute(request)
            .pipe(Effect.mapError((error) => failure("Transport", 0, call, error.message)));
          const text = yield* response.text.pipe(
            Effect.mapError((error) => failure("Transport", 0, call, error.message)),
          );
          const contentType = Option.getOrElse(responseHeader(response, "content-type"), () => "");
          const json =
            text === ""
              ? Option.some<Schema.Json>(null)
              : Schema.decodeOption(Schema.fromJsonString(Schema.Json))(text);
          const parsed = Option.getOrElse(json, (): Schema.Json => null);
          if (response.status < 200 || response.status >= 300) {
            const body = words(parsed);
            const reason = reasonFor(response.status, body.message, response);
            const error = failure(
              reason,
              response.status,
              call,
              `${call} failed with status ${response.status}` +
                (body.message === "" ? "" : `: ${body.message}`) +
                (body.details === "" ? "" : `: ${body.details}`),
            );
            retryInfo.set(error, {
              retryAfter: responseHeader(response, "retry-after"),
              reset: responseHeader(response, "x-ratelimit-reset"),
            });
            return yield* error;
          }
          let input: Schema.Json | string = text;
          if (requestOptions.raw === true) input = text;
          else if (text === "") input = null;
          else if (/json/i.test(contentType)) {
            if (Option.isNone(json))
              return yield* failure(
                "Decode",
                response.status,
                call,
                "response body is not valid JSON",
              );
            input = json.value;
          }
          const body = yield* Schema.decodeUnknownEffect(requestOptions.schema)(input).pipe(
            Effect.mapError((error) => failure("Decode", response.status, call, error.message)),
          );
          const links = parseLinkHeader(
            Option.getOrElse(responseHeader(response, "link"), () => ""),
          );
          return {
            status: response.status,
            body,
            etag: responseHeader(response, "etag"),
            lastModified: responseHeader(response, "last-modified"),
            next: Option.fromNullishOr(links.get("next")),
            last: Option.fromNullishOr(links.get("last")),
          } satisfies Answer<A>;
        });

        const waitForRateLimit = Effect.fn("GitHubApi.waitForRateLimit")(function* (
          error: GitHubApiError,
        ) {
          const info = retryInfo.get(error);
          const after = Number(Option.getOrUndefined(info?.retryAfter ?? Option.none()));
          let wait = Number.isFinite(after) ? after * 1_000 : 60_000;
          const reset = Number(Option.getOrUndefined(info?.reset ?? Option.none()));
          if (!Number.isFinite(after) && Number.isFinite(reset)) {
            wait = Math.max(0, reset * 1_000 - (yield* Clock.currentTimeMillis));
          }
          if (wait > 60_000) return yield* error;
          yield* Effect.sleep(wait);
        });
        const retried = <A>(operation: Effect.Effect<A, GitHubApiError>) =>
          Effect.gen(function* () {
            let transients = 0;
            let rateAttempted = false;
            while (true) {
              const result = yield* Effect.result(operation);
              if (result._tag === "Success") return result.success;
              const error = result.failure;
              if ((error.reason === "Server" || error.reason === "Transport") && transients < 3) {
                yield* Effect.sleep(500 * 2 ** transients * (0.5 + (yield* Random.next)));
                transients += 1;
              } else if (error.reason === "RateLimited" && !rateAttempted) {
                rateAttempted = true;
                yield* waitForRateLimit(error);
              } else return yield* error;
            }
          });
        const appRequest = <A>(method: Method, path: string, opts: RequestOptions<A>) =>
          retried(
            Effect.flatMap(currentJwt(`${method} ${path}`), (bearer) =>
              execute(bearer, method, path, opts),
            ),
          );
        const forgetInternal = (auth: GitHubAuth): void => {
          if (auth._tag === "App") jwt = undefined;
          else if (auth._tag === "Installation")
            tokens.delete(`installation:${auth.installationId}`);
          else if (auth._tag === "Repository") {
            const repository = `${auth.owner}/${auth.repo}`.toLowerCase();
            tokens.delete(`repo:${repository}`);
            installations.delete(repository);
          }
        };

        const tokenFor = Effect.fn("GitHubApi.tokenFor")(function* (
          auth: Exclude<GitHubAuth, { _tag: "App" }>,
        ) {
          if (auth._tag === "Token")
            return {
              token: auth.token,
              expiresAt: DateTime.makeUnsafe("9999-12-31T23:59:59Z"),
            } satisfies InstallationToken;
          const repositoryAuth = auth._tag === "Repository" ? auth : undefined;
          const repository =
            repositoryAuth === undefined
              ? undefined
              : `${repositoryAuth.owner}/${repositoryAuth.repo}`.toLowerCase();
          const key =
            auth._tag === "Installation"
              ? `installation:${auth.installationId}`
              : `repo:${repository}`;
          return yield* lockFor(key).withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const cached = tokens.get(key);
              if (cached !== undefined && now < cached.refreshAt) return cached;
              let installationId = auth._tag === "Installation" ? auth.installationId : undefined;
              if (installationId === undefined && repository !== undefined) {
                installationId = installations.get(repository);
                if (installationId === undefined) {
                  if (repositoryAuth === undefined)
                    return yield* noApp("GET /repos/{owner}/{repo}/installation");
                  const found = yield* appRequest(
                    "GET",
                    `/repos/${encodeURIComponent(repositoryAuth.owner)}/${encodeURIComponent(repositoryAuth.repo)}/installation`,
                    { schema: InstallationResponse },
                  );
                  installationId = found.body.id;
                  installations.set(repository, installationId);
                }
              }
              if (installationId === undefined) return yield* noApp("POST /app/installations");
              yield* Effect.logDebug(`minting GitHub installation token for ${key}`);
              const minted = yield* appRequest(
                "POST",
                `/app/installations/${installationId}/access_tokens`,
                {
                  body: repositoryAuth === undefined ? {} : { repositories: [repositoryAuth.repo] },
                  schema: TokenResponse,
                },
              );
              const expiresAt = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(
                minted.body.expires_at,
              ).pipe(
                Effect.mapError((error) =>
                  failure(
                    "Decode",
                    minted.status,
                    `POST /app/installations/${installationId}/access_tokens`,
                    error.message,
                  ),
                ),
              );
              const fresh: CachedToken = {
                token: Redacted.make(minted.body.token),
                expiresAt,
                refreshAt: DateTime.toEpochMillis(expiresAt) - 10 * 60_000,
              };
              tokens.set(key, fresh);
              return fresh;
            }),
          );
        });

        const request = Effect.fn("GitHubApi.request")(function* <A>(
          auth: GitHubAuth,
          method: Method,
          path: string,
          opts: RequestOptions<A>,
        ) {
          const once = Effect.gen(function* () {
            const bearer =
              auth._tag === "App"
                ? yield* currentJwt(`${method} ${path}`)
                : Redacted.value((yield* tokenFor(auth)).token);
            return yield* execute(bearer, method, path, opts);
          });
          const first = yield* Effect.result(retried(once));
          if (
            first._tag === "Failure" &&
            first.failure.reason === "Unauthorized" &&
            (auth._tag === "Installation" || auth._tag === "Repository")
          ) {
            forgetInternal(auth);
            return yield* retried(once);
          }
          return first._tag === "Success" ? first.success : yield* first.failure;
        });
        const graphql = Effect.fn("GitHubApi.graphql")(function* <A>(
          auth: GitHubAuth,
          query: string,
          variables: Readonly<Record<string, Schema.Json>>,
          schema: Schema.Codec<A>,
        ) {
          const answer = yield* request(auth, "POST", "/graphql", {
            body: { query, variables },
            schema: GraphqlResponse,
          });
          if (answer.body.errors !== undefined && answer.body.errors.length > 0) {
            return yield* failure(
              "Validation",
              answer.status,
              "POST /graphql",
              answer.body.errors.map((error) => error.message).join("; "),
            );
          }
          return yield* Schema.decodeUnknownEffect(schema)(answer.body.data).pipe(
            Effect.mapError((error) =>
              failure("Decode", answer.status, "POST /graphql", error.message),
            ),
          );
        });
        return GitHubApi.of({
          request,
          graphql,
          token: Effect.fn("GitHubApi.token")(tokenFor),
          forget: Effect.fn("GitHubApi.forget")((auth: GitHubAuth) =>
            Effect.sync(() => forgetInternal(auth)),
          ),
        });
      }),
    );
}

/**
 * The newest `limit` items of a list GitHub only pages oldest-first, such as
 * an issue's comments: that endpoint ignores `sort` and `direction`, so the
 * first page holds the oldest. When there are more pages, the last one is
 * read, and the one before it when the last is short.
 */
export const latest = Effect.fn("GitHubApi.latest")(function* <A>(
  api: GitHubApi["Service"],
  auth: GitHubAuth,
  path: string,
  schema: Schema.Codec<ReadonlyArray<A>>,
  limit: number,
) {
  const first = yield* api.request(auth, "GET", path, {
    query: { per_page: String(limit) },
    schema,
  });
  if (Option.isNone(first.last)) return first.body;
  const last = yield* api.request(auth, "GET", first.last.value, { schema });
  if (last.body.length >= limit) return last.body;
  const url = new URL(first.last.value);
  const page = Number(url.searchParams.get("page"));
  if (!(page > 2)) return [...first.body, ...last.body].slice(-limit);
  url.searchParams.set("page", String(page - 1));
  const before = yield* api.request(auth, "GET", url.toString(), { schema });
  return [...before.body, ...last.body].slice(-limit);
});
