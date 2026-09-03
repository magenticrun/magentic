import { CapabilityAnnotation, ToolCallContext } from "@magentic/plugin";
import { Context, DateTime, Effect, Option, Ref, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { type GitHubApi, type GitHubApiError, type GitHubAuth, latest } from "./GitHubApi.ts";
import type { Git, GitError } from "./Git.ts";

/**
 * The forge tools: what an agent can do to a repository as the bot. They
 * take the repository as a parameter and mint their own token for it, so
 * they work the same whether the run came from a GitHub mention, a ticket
 * elsewhere, or the CLI. Reads carry `forge:read`, writes `forge:write`,
 * so policy can turn the writes on per surface.
 */

export class ForgeToolError extends Schema.TaggedError<ForgeToolError>()("ForgeToolError", {
  message: Schema.String,
}) {}

/** What a run may push to, and who asked, kept per conversation by the bridge and read by the tools. */
export interface RunPermit {
  /** Branch names `forge_push` accepts: the pull request's own, and any `forge_checkout` created. */
  readonly refs: ReadonlySet<string>;
  /** The person behind the mention, for the co-author trailer. */
  readonly requester: Option.Option<{ readonly id: number; readonly login: string }>;
}

export class RunPermits extends Context.Service<
  RunPermits,
  {
    get(conversationId: string): Effect.Effect<RunPermit>;
    set(conversationId: string, permit: RunPermit): Effect.Effect<void>;
    allow(conversationId: string, ref: string): Effect.Effect<void>;
  }
>()("magentic/bridge-github/RunPermits") {
  static readonly make: Effect.Effect<RunPermits["Service"]> = Effect.map(
    Ref.make(new Map<string, RunPermit>()),
    (permits) =>
      RunPermits.of({
        get: (id) =>
          Effect.map(
            Ref.get(permits),
            (all) => all.get(id) ?? { refs: new Set<string>(), requester: Option.none() },
          ),
        set: (id, permit) => Ref.update(permits, (all) => new Map(all).set(id, permit)),
        allow: (id, ref) =>
          Ref.update(permits, (all) => {
            const current = all.get(id) ?? { refs: new Set<string>(), requester: Option.none() };
            return new Map(all).set(id, { ...current, refs: new Set([...current.refs, ref]) });
          }),
      }),
  );
}

const Repository = Schema.String.annotate({ description: "The repository, as owner/name" });
const Number = Schema.Int.annotate({ description: "The issue or pull request number" });

const RepositoryRef = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
});

const parseRepository = (repository: string) =>
  Effect.gen(function* () {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return yield* new ForgeToolError({
        message: `repository must be owner/name, got ${JSON.stringify(repository)}`,
      });
    }
    return { owner: match[1], repo: match[2] } satisfies typeof RepositoryRef.Type;
  });

const CommentRecord = Schema.Struct({
  author: Schema.String,
  createdAt: Schema.String,
  body: Schema.String,
});

const FileRecord = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});

const ReadResult = Schema.Struct({
  kind: Schema.Literals(["issue", "pull_request"]),
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  url: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.String),
  /** The latest comments, oldest first. */
  comments: Schema.Array(CommentRecord),
  pull: Schema.optional(
    Schema.Struct({
      headRef: Schema.String,
      headSha: Schema.String,
      headRepository: Schema.optional(Schema.String),
      baseRef: Schema.String,
      draft: Schema.Boolean,
      files: Schema.Array(FileRecord),
      diff: Schema.String,
      /** The diff was cut, or GitHub would not serve it at all; the files list is still complete. */
      diffTruncated: Schema.Boolean,
    }),
  ),
});

/** A diff longer than this is cut; the files list still names everything. */
const DIFF_LIMIT = 60_000;
const COMMENT_LIMIT = 30;

export const ForgeRead = Tool.make("forge_read", {
  description:
    "Read an issue or a pull request on GitHub: title, body, labels, the latest comments, and for a " +
    "pull request its branches, the files it changes, and its diff. Use it to learn what a thread " +
    "asks before acting on it, or to look at a pull request the workspace does not have checked out.",
  parameters: Schema.Struct({ repository: Repository, number: Number }),
  success: ReadResult,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(CapabilityAnnotation, "forge:read");

const Posted = Schema.Struct({ url: Schema.String });

export const ForgeComment = Tool.make("forge_comment", {
  description:
    "Post a comment on an issue or a pull request as the bot. Not for answering the mention you " +
    "are working on: the bridge posts your final message there itself. Use it for a different " +
    "issue or pull request, or to leave a note before a long task.",
  parameters: Schema.Struct({
    repository: Repository,
    number: Number,
    body: Schema.NonEmptyString.annotate({ description: "The comment, in GitHub markdown" }),
  }),
  success: Posted,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "forge:write");

export const ForgeReviewComment = Tool.make("forge_review_comment", {
  description:
    "Comment on a specific line of a pull request's diff, optionally with a suggestion the author " +
    "can apply in one click. The line is numbered in the file as it is on the given side of the diff.",
  parameters: Schema.Struct({
    repository: Repository,
    number: Number,
    path: Schema.String.annotate({ description: "The file, relative to the repository root" }),
    line: Schema.Int.annotate({ description: "The line the comment is on, in the file on `side`" }),
    body: Schema.NonEmptyString.annotate({ description: "The comment, in GitHub markdown" }),
    side: Schema.optionalKey(
      Schema.Literals(["LEFT", "RIGHT"]).annotate({
        description: "RIGHT (the default) for the new file, LEFT for the old one",
      }),
    ),
    startLine: Schema.optionalKey(
      Schema.Int.annotate({ description: "For a comment spanning lines, the first line" }),
    ),
    suggestion: Schema.optionalKey(
      Schema.String.annotate({
        description: "Replacement text for the commented lines, offered as a one-click suggestion",
      }),
    ),
  }),
  success: Posted,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "forge:write");

const CheckedOut = Schema.Struct({
  branch: Schema.String,
  /** What the branch started from: a pull request's head, or the default branch. */
  from: Schema.String,
  sha: Schema.String,
  /** The trailer to end each commit message with, crediting the person who asked. */
  coAuthoredBy: Schema.optional(Schema.String),
  note: Schema.String,
});

export const ForgeCheckout = Tool.make("forge_checkout", {
  description:
    "Prepare the workspace to change code: fetch a pull request's branch and check it out, or start " +
    "a new branch from the default branch for work on an issue. Call it before editing files. The " +
    "workspace must be a checkout of the repository; commits are configured to show the bot as author.",
  parameters: Schema.Struct({
    repository: Repository,
    pullRequest: Schema.optionalKey(
      Schema.Int.annotate({ description: "The pull request whose branch to check out" }),
    ),
    issue: Schema.optionalKey(
      Schema.Int.annotate({ description: "The issue the new branch is for, used in its name" }),
    ),
    branch: Schema.optionalKey(
      Schema.String.annotate({
        description: "A name for the new branch; must be under the bot's branch prefix",
      }),
    ),
  }),
  success: CheckedOut,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "forge:write");

const Pushed = Schema.Struct({
  branch: Schema.String,
  sha: Schema.String,
  /** Where to open a pull request from the branch, or the pull request it updated. */
  url: Schema.String,
});

export const ForgePush = Tool.make("forge_push", {
  description:
    "Push the workspace's current branch to GitHub as the bot. Only the branch forge_checkout " +
    "prepared, or a pull request's own branch, is accepted; commit first with git in shell.",
  parameters: Schema.Struct({
    repository: Repository,
    branch: Schema.optionalKey(
      Schema.String.annotate({ description: "The branch to push; the current one by default" }),
    ),
  }),
  success: Pushed,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "forge:write");

const Opened = Schema.Struct({ number: Schema.Int, url: Schema.String });

export const ForgeOpenPr = Tool.make("forge_open_pr", {
  description:
    "Open a draft pull request from a pushed branch. When the work started from an issue, pass it " +
    "as closes so the pull request closes it on merge. The bot cannot mark a pull request ready, " +
    "approve, or merge; a person does those.",
  parameters: Schema.Struct({
    repository: Repository,
    title: Schema.NonEmptyString,
    body: Schema.String.annotate({
      description: "What the change does and why, in GitHub markdown",
    }),
    head: Schema.optionalKey(
      Schema.String.annotate({ description: "The branch to merge; the current one by default" }),
    ),
    base: Schema.optionalKey(
      Schema.String.annotate({
        description: "The branch to merge into; the default branch by default",
      }),
    ),
    closes: Schema.optionalKey(
      Schema.Int.annotate({ description: "An issue the pull request closes" }),
    ),
  }),
  success: Opened,
  failure: ForgeToolError,
  failureMode: "return",
  dependencies: [ToolCallContext],
}).annotate(CapabilityAnnotation, "forge:write");

export const ForgeTools = Toolkit.make(
  ForgeRead,
  ForgeComment,
  ForgeReviewComment,
  ForgeCheckout,
  ForgePush,
  ForgeOpenPr,
);

/** What the handlers are built with. */
export interface ForgeDeps {
  readonly api: GitHubApi["Service"];
  readonly git: Git;
  readonly permits: RunPermits["Service"];
  /** The branch namespace the bot may push to besides a pull request's own. */
  readonly branchPrefix: string;
  /** `github.com`, or the Enterprise host; where clones come from. */
  readonly gitHost: string;
  /** How commits are attributed: the bot's noreply identity, read with the repository's token. */
  readonly botIdentity: (
    auth: GitHubAuth,
  ) => Effect.Effect<{ readonly name: string; readonly email: string }, GitHubApiError>;
}

const IssueResponse = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  html_url: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optional(Schema.Json),
});

const CommentsResponse = Schema.Array(
  Schema.Struct({
    body: Schema.String,
    created_at: Schema.String,
    user: Schema.Struct({ login: Schema.String }),
  }),
);

const PullResponse = Schema.Struct({
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
  draft: Schema.Boolean,
  html_url: Schema.String,
});

const FilesResponse = Schema.Array(
  Schema.Struct({
    filename: Schema.String,
    status: Schema.String,
    additions: Schema.Int,
    deletions: Schema.Int,
  }),
);

const RepositoryResponse = Schema.Struct({ default_branch: Schema.String });
const UserResponse = Schema.Struct({ id: Schema.Int, login: Schema.String });
const CreatedComment = Schema.Struct({ html_url: Schema.String });
const CreatedPull = Schema.Struct({ number: Schema.Int, html_url: Schema.String });

/** The noreply address GitHub attributes a login's commits to. */
export const noreplyEmail = (id: number, login: string) =>
  `${id}+${login}@users.noreply.github.com`;

/** The bot user behind an App slug, for `user.name` and `user.email` on pushed commits. */
/**
 * The bot's git identity, looked up once: an App JWT only opens `/app`
 * routes, so the user lookup goes through an installation's token.
 */
export const botIdentityOf = (api: GitHubApi["Service"], slug: string) => {
  let known: { readonly name: string; readonly email: string } | undefined;
  return (auth: GitHubAuth) =>
    known !== undefined
      ? Effect.succeed(known)
      : Effect.map(
          api.request(auth, "GET", `/users/${encodeURIComponent(`${slug}[bot]`)}`, {
            schema: UserResponse,
          }),
          (answer) => {
            known = {
              name: answer.body.login,
              email: noreplyEmail(answer.body.id, answer.body.login),
            };
            return known;
          },
        );
};

const apiFailed = (error: GitHubApiError | GitError) =>
  new ForgeToolError({ message: error.message });

/** The checkout result with the co-author trailer when there is a person to credit. */
const withTrailer = (
  result: Omit<typeof CheckedOut.Type, "coAuthoredBy">,
  trailer: Option.Option<string>,
): typeof CheckedOut.Type =>
  Option.match(trailer, {
    onNone: () => result,
    onSome: (coAuthoredBy) => ({ ...result, coAuthoredBy }),
  });

export const forgeToolHandlers = (deps: ForgeDeps) =>
  Effect.gen(function* () {
    const { api, git, permits } = deps;

    const authFor = (
      ref: typeof RepositoryRef.Type,
    ): Extract<GitHubAuth, { _tag: "Repository" }> => ({
      _tag: "Repository",
      owner: ref.owner,
      repo: ref.repo,
    });

    const repoPath = (ref: typeof RepositoryRef.Type) =>
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

    /** The workspace is one repository's checkout; a tool asked about another says so. */
    const checkWorkspace = Effect.fn("forge.checkWorkspace")(function* (
      ref: typeof RepositoryRef.Type,
    ) {
      const origin = yield* git.run(["remote", "get-url", "origin"]).pipe(
        Effect.mapError(
          () =>
            new ForgeToolError({
              message: "the workspace is not a git checkout with an origin remote",
            }),
        ),
      );
      const expected = `${ref.owner}/${ref.repo}`.toLowerCase();
      const found = origin.toLowerCase().replace(/\.git$/, "");
      if (!found.endsWith(`/${expected}`) && !found.endsWith(`:${expected}`)) {
        return yield* new ForgeToolError({
          message: `the workspace is a checkout of ${origin}, not ${ref.owner}/${ref.repo}; this gateway serves one repository`,
        });
      }
    });

    const currentBranch = git
      .run(["rev-parse", "--abbrev-ref", "HEAD"])
      .pipe(Effect.mapError(apiFailed));

    const cloneUrl = (ref: typeof RepositoryRef.Type) =>
      `https://${deps.gitHost}/${ref.owner}/${ref.repo}.git`;

    const defaultBranch = (ref: typeof RepositoryRef.Type) =>
      Effect.map(
        api.request(authFor(ref), "GET", repoPath(ref), { schema: RepositoryResponse }),
        (answer) => answer.body.default_branch,
      );

    const read = Effect.fn("forge.read")(function* (repository: string, number: number) {
      const ref = yield* parseRepository(repository);
      const auth = authFor(ref);
      const issue = yield* api
        .request(auth, "GET", `${repoPath(ref)}/issues/${number}`, { schema: IssueResponse })
        .pipe(Effect.mapError(apiFailed));
      const comments = yield* latest(
        api,
        auth,
        `${repoPath(ref)}/issues/${number}/comments`,
        CommentsResponse,
        COMMENT_LIMIT,
      ).pipe(Effect.mapError(apiFailed));
      const base = {
        kind:
          issue.body.pull_request === undefined ? ("issue" as const) : ("pull_request" as const),
        number: issue.body.number,
        title: issue.body.title,
        state: issue.body.state,
        author: issue.body.user.login,
        url: issue.body.html_url,
        body: issue.body.body ?? "",
        labels: issue.body.labels.map((label) => label.name),
        comments: comments.map((comment) => ({
          author: comment.user.login,
          createdAt: comment.created_at,
          body: comment.body,
        })),
      };
      if (base.kind === "issue") {
        return base;
      }
      const pull = yield* api
        .request(auth, "GET", `${repoPath(ref)}/pulls/${number}`, { schema: PullResponse })
        .pipe(Effect.mapError(apiFailed));
      const files = yield* api
        .request(auth, "GET", `${repoPath(ref)}/pulls/${number}/files`, {
          query: { per_page: "100" },
          schema: FilesResponse,
        })
        .pipe(Effect.mapError(apiFailed));
      // GitHub refuses the diff of a very large pull request (406); the files list still tells the story.
      const diff = yield* api
        .request(auth, "GET", `${repoPath(ref)}/pulls/${number}`, {
          accept: "application/vnd.github.diff",
          schema: Schema.String,
        })
        .pipe(
          Effect.map((answer) => answer.body),
          Effect.catchIf(
            (error) => error.status === 406,
            () => Effect.succeed(""),
          ),
          Effect.mapError(apiFailed),
        );
      const headRepository = pull.body.head.repo?.full_name;
      const pullFields = {
        headRef: pull.body.head.ref,
        headSha: pull.body.head.sha,
        baseRef: pull.body.base.ref,
      };
      return {
        ...base,
        pull: {
          ...(headRepository === undefined ? pullFields : { ...pullFields, headRepository }),
          draft: pull.body.draft,
          files: files.body.map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
          diff: diff.slice(0, DIFF_LIMIT),
          diffTruncated: diff.length > DIFF_LIMIT || diff === "",
        },
      };
    });

    const comment = Effect.fn("forge.comment")(function* (
      repository: string,
      number: number,
      body: string,
    ) {
      const ref = yield* parseRepository(repository);
      const created = yield* api
        .request(authFor(ref), "POST", `${repoPath(ref)}/issues/${number}/comments`, {
          body: { body },
          schema: CreatedComment,
        })
        .pipe(Effect.mapError(apiFailed));
      return { url: created.body.html_url };
    });

    const reviewComment = Effect.fn("forge.reviewComment")(function* (
      params: typeof ForgeReviewComment.parametersSchema.Type,
    ) {
      const ref = yield* parseRepository(params.repository);
      const auth = authFor(ref);
      const pull = yield* api
        .request(auth, "GET", `${repoPath(ref)}/pulls/${params.number}`, { schema: PullResponse })
        .pipe(Effect.mapError(apiFailed));
      const body =
        params.suggestion === undefined
          ? params.body
          : `${params.body}\n\n\`\`\`suggestion\n${params.suggestion}\n\`\`\``;
      const anchor = {
        body,
        commit_id: pull.body.head.sha,
        path: params.path,
        line: params.line,
        side: params.side ?? "RIGHT",
      };
      const created = yield* api
        .request(auth, "POST", `${repoPath(ref)}/pulls/${params.number}/comments`, {
          body:
            params.startLine === undefined ? anchor : { ...anchor, start_line: params.startLine },
          schema: CreatedComment,
        })
        .pipe(Effect.mapError(apiFailed));
      return { url: created.body.html_url };
    });

    const checkout = Effect.fn("forge.checkout")(function* (
      params: typeof ForgeCheckout.parametersSchema.Type,
    ) {
      const call = yield* ToolCallContext;
      const ref = yield* parseRepository(params.repository);
      yield* checkWorkspace(ref);
      const auth = authFor(ref);
      const token = yield* api.token(auth).pipe(Effect.mapError(apiFailed));
      const identity = yield* deps.botIdentity(auth).pipe(Effect.mapError(apiFailed));
      const permit = yield* permits.get(call.conversationId);
      const coAuthoredBy = Option.map(
        permit.requester,
        (person) => `Co-authored-by: ${person.login} <${noreplyEmail(person.id, person.login)}>`,
      );
      // The bot signs the commits the model makes in the shell; the person is credited in the trailer.
      yield* git.run(["config", "user.name", identity.name]).pipe(Effect.mapError(apiFailed));
      yield* git.run(["config", "user.email", identity.email]).pipe(Effect.mapError(apiFailed));

      if (params.pullRequest !== undefined) {
        const pull = yield* api
          .request(auth, "GET", `${repoPath(ref)}/pulls/${params.pullRequest}`, {
            schema: PullResponse,
          })
          .pipe(Effect.mapError(apiFailed));
        const headRepository = pull.body.head.repo?.full_name.toLowerCase();
        if (headRepository !== `${ref.owner}/${ref.repo}`.toLowerCase()) {
          return yield* new ForgeToolError({
            message: `pull request #${params.pullRequest} comes from a fork; answer it with comments and suggestions rather than pushes`,
          });
        }
        const branch = pull.body.head.ref;
        yield* git
          .runWithToken(["fetch", cloneUrl(ref), `refs/heads/${branch}`], token.token)
          .pipe(Effect.mapError(apiFailed));
        yield* git.run(["checkout", "-B", branch, "FETCH_HEAD"]).pipe(Effect.mapError(apiFailed));
        yield* permits.allow(call.conversationId, branch);
        return withTrailer(
          {
            branch,
            from: `pull request #${params.pullRequest}`,
            sha: pull.body.head.sha,
            note: `On ${branch}, the pull request's own branch. Commit with git in shell, then forge_push.`,
          },
          coAuthoredBy,
        );
      }

      const base = yield* defaultBranch(ref).pipe(Effect.mapError(apiFailed));
      const stamp = DateTime.formatIso(yield* DateTime.now)
        .replaceAll(/[-:]/g, "")
        .slice(0, 13)
        .replace("T", "-");
      const branch =
        params.branch ??
        `${deps.branchPrefix}${params.issue === undefined ? "task" : `issue-${params.issue}`}-${stamp}`;
      if (!branch.startsWith(deps.branchPrefix)) {
        return yield* new ForgeToolError({
          message: `branch ${branch} is outside the bot's namespace ${deps.branchPrefix}`,
        });
      }
      yield* git
        .runWithToken(["fetch", cloneUrl(ref), `refs/heads/${base}`], token.token)
        .pipe(Effect.mapError(apiFailed));
      yield* git.run(["checkout", "-B", branch, "FETCH_HEAD"]).pipe(Effect.mapError(apiFailed));
      const sha = yield* git.run(["rev-parse", "HEAD"]).pipe(Effect.mapError(apiFailed));
      yield* permits.allow(call.conversationId, branch);
      return withTrailer(
        {
          branch,
          from: base,
          sha,
          note: `On new branch ${branch} from ${base}. Commit with git in shell, then forge_push and forge_open_pr.`,
        },
        coAuthoredBy,
      );
    });

    const push = Effect.fn("forge.push")(function* (repository: string, requested?: string) {
      const call = yield* ToolCallContext;
      const ref = yield* parseRepository(repository);
      yield* checkWorkspace(ref);
      const branch = requested ?? (yield* currentBranch);
      const permit = yield* permits.get(call.conversationId);
      if (!permit.refs.has(branch) && !branch.startsWith(deps.branchPrefix)) {
        return yield* new ForgeToolError({
          message: `refusing to push ${branch}: the bot pushes only to branches forge_checkout prepared, a pull request's own branch, or ${deps.branchPrefix}*`,
        });
      }
      const token = yield* api.token(authFor(ref)).pipe(Effect.mapError(apiFailed));
      yield* git
        .runWithToken(["push", cloneUrl(ref), `${branch}:refs/heads/${branch}`], token.token)
        .pipe(Effect.mapError(apiFailed));
      const sha = yield* git.run(["rev-parse", branch]).pipe(Effect.mapError(apiFailed));
      return {
        branch,
        sha,
        url: `https://${deps.gitHost}/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(branch)}?expand=1`,
      };
    });

    const openPr = Effect.fn("forge.openPr")(function* (
      params: typeof ForgeOpenPr.parametersSchema.Type,
    ) {
      const ref = yield* parseRepository(params.repository);
      const auth = authFor(ref);
      const head = params.head ?? (yield* currentBranch);
      const base = params.base ?? (yield* defaultBranch(ref).pipe(Effect.mapError(apiFailed)));
      const body =
        params.closes === undefined
          ? params.body
          : `${params.body.trimEnd()}\n\nCloses #${params.closes}`;
      const created = yield* api
        .request(auth, "POST", `${repoPath(ref)}/pulls`, {
          body: { title: params.title, head, base, body, draft: true },
          schema: CreatedPull,
        })
        .pipe(Effect.mapError(apiFailed));
      return { number: created.body.number, url: created.body.html_url };
    });

    return ForgeTools.of({
      forge_read: ({ repository, number }) => read(repository, number),
      forge_comment: ({ repository, number, body }) => comment(repository, number, body),
      forge_review_comment: (params) => reviewComment(params),
      forge_checkout: (params) => checkout(params),
      forge_push: ({ repository, branch }) => push(repository, branch),
      forge_open_pr: (params) => openPr(params),
    });
  });
