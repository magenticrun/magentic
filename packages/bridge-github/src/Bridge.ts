import {
  type BridgeCapabilities,
  type BridgeHandle,
  type BridgePerson,
  deliverAnswer,
  deliveryFor,
  type Permission,
  permissionAtLeast,
  PROGRESS_INTERVAL,
  type ProgressState,
  type QuotedSection,
  renderContext,
  trackProgress,
} from "@magentic/plugin";
import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect";
import type { GitHubBridgeConfig } from "./Config.ts";
import { conversationIdFor, type Mention, pullOf, PullRequest } from "./Events.ts";
import { type GitHubApi, type GitHubApiError, type GitHubAuth, latest } from "./GitHubApi.ts";
import type { BridgeState } from "./State.ts";
import type { RunPermits } from "./Tools.ts";

/** What handling a mention needs. */
export interface BridgeDeps {
  readonly config: GitHubBridgeConfig;
  readonly api: GitHubApi["Service"];
  readonly handle: BridgeHandle;
  readonly state: BridgeState["Service"];
  readonly permits: RunPermits["Service"];
  /** What the bridge told the host it can do; where the answer goes follows from it. */
  readonly capabilities: BridgeCapabilities;
}

const PermissionResponse = Schema.Struct({
  permission: Schema.String,
  role_name: Schema.optional(Schema.String),
});
const CreatedComment = Schema.Struct({ id: Schema.Int, html_url: Schema.String });
const CheckRun = Schema.Struct({ id: Schema.Int });
const Comments = Schema.Array(
  Schema.Struct({
    id: Schema.Int,
    body: Schema.String,
    html_url: Schema.String,
    created_at: Schema.String,
    user: Schema.Struct({ login: Schema.String, type: Schema.String }),
  }),
);

/** How long a permission lookup is trusted before GitHub is asked again. */
const PERMISSION_TTL = Duration.minutes(5);
/** Comments carried into the first run on a thread, when there is no earlier run to count from. */
const FIRST_RUN_COMMENTS = 10;

const toPermission = (value: string): Permission =>
  value === "admin" || value === "write" || value === "read" ? value : "none";

const repoPath = (mention: Mention) =>
  `/repos/${encodeURIComponent(mention.repository.owner)}/${encodeURIComponent(mention.repository.repo)}`;

const authFor = (mention: Mention): GitHubAuth =>
  Option.match(mention.installationId, {
    onNone: () => ({
      _tag: "Repository",
      owner: mention.repository.owner,
      repo: mention.repository.repo,
    }),
    onSome: (installationId) => ({ _tag: "Installation", installationId }),
  });

const toolLines = (state: ProgressState) =>
  state.tools.map(
    (tool) => `- ${tool.name}: ${tool.ok === undefined ? "running" : tool.ok ? "ok" : "failed"}`,
  );

/**
 * The progress message as the thread sees it. GitHub mails a comment when it
 * is created and never again, so this body is what everyone watching reads,
 * frozen mid-run: it has to say where the answer will be.
 */
const renderProgress = (slug: string, state: ProgressState): string =>
  [
    `@${slug} is working on this. The answer will arrive in a new comment below.`,
    "",
    ...toolLines(state),
  ].join("\n");

/**
 * What the progress message becomes once the answer is posted: a collapsed
 * log, so the thread keeps the record of the run without the noise. The blank
 * lines are what makes GitHub render markdown inside `<details>`.
 */
const renderLog = (slug: string, state: ProgressState): string => {
  const count = state.tools.length;
  return [
    `<details><summary>@${slug} · ${count} tool call${count === 1 ? "" : "s"}</summary>`,
    "",
    ...toolLines(state),
    "",
    "</details>",
  ].join("\n");
};

const footer = (conversationId: string) =>
  `\n\n<sub>magentic · conversation \`${conversationId}\`</sub>`;

export const handleMention = (deps: BridgeDeps) => {
  const { config, api, handle, state, permits, capabilities } = deps;
  const delivery = Option.getOrElse(config.progressAfter, () => deliveryFor(capabilities));
  /** Permission lookups, by `owner/repo/login`, for a few minutes. */
  const permissionCache = new Map<
    string,
    {
      readonly groups: ReadonlyArray<string>;
      readonly permission: Permission;
      readonly until: number;
    }
  >();

  /** What the person may do in the repository, from GitHub, not from `author_association`. */
  const groupsOf = Effect.fn("githubBridge.groupsOf")(function* (mention: Mention) {
    const login = mention.author.login;
    const key = `${mention.repository.owner}/${mention.repository.repo}/${login}`.toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = permissionCache.get(key);
    if (cached !== undefined && cached.until > now) {
      return cached;
    }
    // `NONE` is a hint that saves the call for a stranger; anyone else is asked about.
    const allowListed = config.allow.logins.has(login.toLowerCase());
    const permission =
      mention.author.association === "NONE" && !allowListed
        ? "none"
        : yield* api
            .request(
              authFor(mention),
              "GET",
              `${repoPath(mention)}/collaborators/${encodeURIComponent(login)}/permission`,
              { schema: PermissionResponse },
            )
            .pipe(
              Effect.map((answer) => toPermission(answer.body.permission)),
              Effect.catchTag("GitHubApiError", (error: GitHubApiError) =>
                error.reason === "NotFound"
                  ? Effect.succeed<Permission>("none")
                  : Effect.logWarning(
                      `github bridge: cannot read ${login}'s permission on ${key}: ${error.message}`,
                    ).pipe(Effect.as<Permission>("none")),
              ),
            );
    // A stranger is not a member; only someone with a standing is asked about.
    const member =
      mention.repository.ownerIsOrganization && (permission !== "none" || allowListed)
        ? yield* api
            .request(
              authFor(mention),
              "GET",
              `/orgs/${encodeURIComponent(mention.repository.owner)}/members/${encodeURIComponent(login)}`,
              { schema: Schema.NullOr(Schema.Json) },
            )
            .pipe(
              Effect.as(true),
              Effect.catchTag("GitHubApiError", () => Effect.succeed(false)),
            )
        : false;
    const found = {
      permission,
      groups: [permission, ...(member ? ["org-member"] : []), ...(allowListed ? ["allowed"] : [])],
      until: now + Duration.toMillis(PERMISSION_TTL),
    };
    permissionCache.set(key, found);
    return found;
  });

  const react = Effect.fn("githubBridge.react")(function* (mention: Mention) {
    const path = (() => {
      switch (mention.source.kind) {
        case "comment":
          return `${repoPath(mention)}/issues/comments/${mention.source.id}/reactions`;
        case "review_comment":
          return `${repoPath(mention)}/pulls/comments/${mention.source.id}/reactions`;
        default:
          return `${repoPath(mention)}/issues/${mention.target.number}/reactions`;
      }
    })();
    yield* api
      .request(authFor(mention), "POST", path, { body: { content: "eyes" }, schema: Schema.Json })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`github bridge: cannot react on ${mention.url}: ${error.message}`),
        ),
      );
  });

  const postComment = (mention: Mention, body: string) =>
    Effect.map(
      api.request(
        authFor(mention),
        "POST",
        `${repoPath(mention)}/issues/${mention.target.number}/comments`,
        {
          body: { body },
          schema: CreatedComment,
        },
      ),
      (answer) => answer.body,
    );

  /** Where the progress and the answer go: a reply on the diff when the mention was there, else the thread. */
  const sinkFor = (mention: Mention) => {
    const source = mention.source;
    const onDiff = source.kind === "review_comment";
    return {
      create: (text: string) =>
        onDiff
          ? Effect.map(
              api.request(
                authFor(mention),
                "POST",
                `${repoPath(mention)}/pulls/${mention.target.number}/comments/${source.id}/replies`,
                { body: { body: text }, schema: CreatedComment },
              ),
              (answer) => String(answer.body.id),
            )
          : Effect.map(postComment(mention, text), (created) => String(created.id)),
      edit: (id: string, text: string) =>
        Effect.asVoid(
          api.request(
            authFor(mention),
            "PATCH",
            onDiff
              ? `${repoPath(mention)}/pulls/comments/${id}`
              : `${repoPath(mention)}/issues/comments/${id}`,
            { body: { body: text }, schema: Schema.Json },
          ),
        ),
      remove: (id: string) =>
        Effect.asVoid(
          api.request(
            authFor(mention),
            "DELETE",
            onDiff
              ? `${repoPath(mention)}/pulls/comments/${id}`
              : `${repoPath(mention)}/issues/comments/${id}`,
            { schema: Schema.NullOr(Schema.Json) },
          ),
        ),
    };
  };

  /** A check run on the pull request's head, when the mention is on one and Checks are granted. */
  const startCheck = Effect.fn("githubBridge.startCheck")(function* (mention: Mention) {
    if (Option.isNone(mention.pull)) {
      return Option.none<number>();
    }
    return yield* api
      .request(authFor(mention), "POST", `${repoPath(mention)}/check-runs`, {
        body: {
          name: "magentic",
          head_sha: mention.pull.value.headSha,
          status: "in_progress",
          output: {
            title: "magentic is working",
            summary: `Asked by @${mention.author.login} at ${mention.url}`,
          },
        },
        schema: CheckRun,
      })
      .pipe(
        Effect.map((answer) => Option.some(answer.body.id)),
        Effect.catch((error) =>
          Effect.logWarning(`github bridge: cannot create a check run: ${error.message}`).pipe(
            Effect.as(Option.none<number>()),
          ),
        ),
      );
  });

  const finishCheck = (
    mention: Mention,
    id: Option.Option<number>,
    conclusion: "success" | "failure" | "neutral",
    summary: string,
  ) =>
    Option.isNone(id)
      ? Effect.void
      : api
          .request(authFor(mention), "PATCH", `${repoPath(mention)}/check-runs/${id.value}`, {
            body: {
              status: "completed",
              conclusion,
              output: { title: `magentic: ${conclusion}`, summary: summary.slice(0, 60_000) },
            },
            schema: Schema.Json,
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(`github bridge: cannot complete the check run: ${error.message}`),
            ),
          );

  /** The comments since the last run, or the latest few before a first one, the bridge's own left out. */
  const recentComments = Effect.fn("githubBridge.recentComments")(function* (
    mention: Mention,
    since: Option.Option<string>,
  ) {
    const path = `${repoPath(mention)}/issues/${mention.target.number}/comments`;
    const none: typeof Comments.Type = [];
    const ordered = yield* Option.match(since, {
      onNone: () => latest(api, authFor(mention), path, Comments, FIRST_RUN_COMMENTS),
      onSome: (at) =>
        Effect.map(
          api.request(authFor(mention), "GET", path, {
            query: { since: at, per_page: "50" },
            schema: Comments,
          }),
          (answer) => answer.body,
        ),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`github bridge: cannot list comments: ${error.message}`).pipe(
          Effect.as(none),
        ),
      ),
    );
    const mentionId = mention.source.kind === "comment" ? mention.source.id : undefined;
    return ordered.filter((comment) => comment.user.type === "User" && comment.id !== mentionId);
  });

  /** The input the model gets: the thread quoted, the mention last. */
  const buildInput = Effect.fn("githubBridge.buildInput")(function* (
    mention: Mention,
    since: Option.Option<string>,
  ) {
    const repository = `${mention.repository.owner}/${mention.repository.repo}`;
    const kind = mention.target.kind === "issue" ? "issue" : "pull request";
    const sections: Array<QuotedSection> = [
      {
        tag: mention.target.kind,
        attrs: {
          number: String(mention.target.number),
          title: mention.target.title,
          author: mention.target.author,
          state: mention.target.state,
          url: mention.target.url,
        },
        body: mention.target.body || "(no description)",
      },
    ];
    for (const comment of yield* recentComments(mention, since)) {
      sections.push({
        tag: "comment",
        attrs: { author: comment.user.login, at: comment.created_at, url: comment.html_url },
        body: comment.body,
      });
    }
    if (mention.source.kind === "review_comment") {
      sections.push({
        tag: "diff",
        attrs: {
          path: mention.source.path,
          line: Option.match(mention.source.line, { onNone: () => "", onSome: String }),
          commit: mention.source.commitId,
        },
        body: mention.source.diffHunk,
      });
    }
    const how = (() => {
      switch (mention.source.kind) {
        case "assignment":
          return `assigned to the bot by @${mention.author.login}`;
        case "label":
          return `labelled for the bot by @${mention.author.login}`;
        case "body":
          return `opened by @${mention.author.login}, mentioning the bot`;
        default:
          return `mentioned by @${mention.author.login}`;
      }
    })();
    sections.push({
      tag: "mention",
      attrs: { author: mention.author.login, url: mention.url },
      body: mention.text,
    });
    const branch = Option.match(mention.pull, {
      onNone: () =>
        `For code changes, call forge_checkout with issue ${mention.target.number} to start a branch, then forge_push and forge_open_pr.`,
      onSome: (pull) =>
        `The pull request's branch is ${pull.headRef} (base ${pull.baseRef}); forge_checkout with pullRequest ${mention.target.number} checks it out, and forge_push pushes to it.`,
    });
    const intro = [
      `You were ${how} on GitHub, in ${repository} ${kind} #${mention.target.number}: "${mention.target.title}" (${mention.target.url}).`,
      `The repository for the forge tools is ${repository}. ${branch}`,
      `Answer for the thread: the bridge posts your final message there, so do not post it with forge_comment yourself.`,
    ].join(" ");
    return renderContext("github", intro, sections);
  });

  /**
   * A comment on a pull request arrives as an issue comment, without the
   * pull request's branches; they are looked up so the run knows what to
   * check out and push to, and the check run has a commit to attach to.
   */
  const withPull = Effect.fn("githubBridge.withPull")(function* (mention: Mention) {
    if (mention.target.kind !== "pull_request" || Option.isSome(mention.pull)) {
      return mention;
    }
    return yield* api
      .request(authFor(mention), "GET", `${repoPath(mention)}/pulls/${mention.target.number}`, {
        schema: PullRequest,
      })
      .pipe(
        Effect.map((answer): Mention => ({ ...mention, pull: pullOf(answer.body) })),
        Effect.catch((error) =>
          Effect.logWarning(
            `github bridge: cannot read pull request #${mention.target.number}: ${error.message}`,
          ).pipe(Effect.as(mention)),
        ),
      );
  });

  return Effect.fn("githubBridge.handleMention")(function* (heard: Mention) {
    const mention = yield* withPull(heard);
    const repository = `${mention.repository.owner}/${mention.repository.repo}`;
    const where = `${repository}#${mention.target.number}`;
    if (!mention.repository.isPrivate && !config.admitPublic) {
      yield* Effect.logInfo(
        `github bridge: ignoring a mention on public ${where}; set public.admit to answer there`,
      );
      return;
    }
    const { permission, groups } = yield* groupsOf(mention);
    const admitted =
      permissionAtLeast(permission, config.allow.minimum) ||
      config.allow.logins.has(mention.author.login.toLowerCase());
    if (!admitted) {
      yield* Effect.logInfo(
        `github bridge: @${mention.author.login} (${permission}) may not trigger runs on ${where}`,
      );
      if (permission !== "none") {
        yield* postComment(
          mention,
          `Sorry @${mention.author.login}, only people with ${config.allow.minimum} access to this repository can ask @${config.slug} to work here.`,
        ).pipe(Effect.ignore);
      }
      return;
    }

    const conversationId = conversationIdFor(mention);
    const person: BridgePerson = {
      id: String(mention.author.id),
      displayName: mention.author.login,
      groups,
    };
    yield* react(mention);

    // A second mention while the bot works joins the run rather than queueing a second one.
    const steered = yield* handle
      .steer(
        conversationId,
        `@${mention.author.login} added on ${mention.url}:\n\n${mention.text}`,
        person,
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`github bridge: cannot steer ${conversationId}: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (steered) {
      yield* Effect.logInfo(`github bridge: steered the run on ${where}`);
      return;
    }

    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const since = yield* state.threadRunAt(conversationId);
    const sameRepository = Option.exists(
      mention.pull,
      (pull) =>
        Option.isSome(pull.headRepo) &&
        pull.headRepo.value.toLowerCase() === repository.toLowerCase(),
    );
    yield* permits.set(conversationId, {
      refs: new Set(
        Option.isSome(mention.pull) && sameRepository ? [mention.pull.value.headRef] : [],
      ),
      requester: Option.some({ id: mention.author.id, login: mention.author.login }),
    });
    const input = yield* buildInput(mention, since);
    const check = yield* startCheck(mention);
    yield* state.markThreadRun(conversationId, startedAt);

    const runId = yield* Ref.make(Option.none<string>());
    const lastTool = yield* Ref.make(
      Option.none<{ readonly name: string; readonly params: Schema.Json }>(),
    );
    const events = handle
      .run({ agent: config.agent, conversationId, input, onBehalfOf: person })
      .pipe(
        Stream.tap((event) => {
          switch (event._tag) {
            case "RunStarted":
              return Ref.set(runId, Option.some(event.runId));
            case "ToolCall":
              return Ref.set(lastTool, Option.some({ name: event.name, params: event.params }));
            default:
              return Effect.void;
          }
        }),
      );
    const outcome = yield* trackProgress(events, {
      sink: sinkFor(mention),
      render: (progress) => renderProgress(config.slug, progress),
      interval: PROGRESS_INTERVAL,
    }).pipe(Effect.result);

    if (outcome._tag === "Failure") {
      const error = outcome.failure;
      const message =
        error._tag === "RunDenied"
          ? `@${mention.author.login}, this request was not admitted: ${error.reason}.`
          : error._tag === "AgentNotFound"
            ? `The agent "${error.name}" the bridge is configured to run does not exist on the gateway.`
            : `magentic could not finish: ${error.message}`;
      yield* Effect.logWarning(`github bridge: run on ${where} failed: ${message}`);
      yield* postComment(mention, message + footer(conversationId)).pipe(Effect.ignore);
      yield* finishCheck(mention, check, "failure", message);
      return;
    }

    const { messageId, state: progress } = outcome.success;
    const answer = progress.text.trim() || progress.earlier.at(-1)?.trim() || "";
    const id = Option.getOrUndefined(yield* Ref.get(runId));
    // The agent answered the thread itself through forge_comment; posting the answer again would double it.
    const answeredItself = Option.exists(
      yield* Ref.get(lastTool),
      (tool) =>
        tool.name === "forge_comment" &&
        Schema.is(Schema.Struct({ number: Schema.Int }))(tool.params) &&
        tool.params.number === mention.target.number,
    );
    const failure = Option.getOrUndefined(progress.failed);
    const text =
      failure !== undefined
        ? `magentic could not finish: ${failure.message}${id === undefined ? "" : ` (run ${id})`}`
        : answeredItself
          ? `Done; see the comment above.`
          : answer || "Done, with nothing further to say.";
    yield* deliverAnswer({
      sink: sinkFor(mention),
      outcome: outcome.success,
      answer: text + footer(conversationId),
      log: (done) => renderLog(config.slug, done),
      delivery,
      failed: failure !== undefined,
      spoken: answeredItself,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`github bridge: cannot post the answer on ${where}: ${error.message}`),
      ),
    );
    const pushed = progress.tools.some((tool) => tool.name === "forge_push" && tool.ok === true);
    yield* finishCheck(
      mention,
      check,
      failure !== undefined ? "failure" : pushed ? "success" : "neutral",
      text,
    );
  });
};
