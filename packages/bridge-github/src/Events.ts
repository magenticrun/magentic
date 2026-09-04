import { stripHiddenMarkup, triggered } from "@magentic/plugin";
import { Option, Schema } from "effect";

/**
 * The webhook payloads the bridge models, trimmed to the fields it reads.
 * Names are GitHub's so a payload decodes as sent; everything else the
 * payload carries is ignored.
 */

export const GitHubUser = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  /** `User`, `Bot`, or `Organization`. The bridge's own comments come back as `Bot`. */
  type: Schema.String,
});
export type GitHubUser = typeof GitHubUser.Type;

export const Repository = Schema.Struct({
  name: Schema.String,
  full_name: Schema.String,
  private: Schema.Boolean,
  owner: Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }),
  default_branch: Schema.optional(Schema.String),
});
export type Repository = typeof Repository.Type;

/** An issue, or the issue half of a pull request; `pull_request` is present only on the latter. */
export const Issue = Schema.Struct({
  /** The author's standing on the repository, in webhook payloads. */
  author_association: Schema.optional(Schema.String),
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.String,
  user: GitHubUser,
  pull_request: Schema.optional(Schema.Json),
  labels: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
export type Issue = typeof Issue.Type;

export const Comment = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  html_url: Schema.String,
  user: GitHubUser,
  author_association: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.String),
  /** On comments listed by repository: the issue they belong to. */
  issue_url: Schema.optional(Schema.String),
});
export type Comment = typeof Comment.Type;

/** A comment on the diff; a different id space from issue comments. */
export const ReviewComment = Schema.Struct({
  ...Comment.fields,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  side: Schema.optional(Schema.String),
  commit_id: Schema.String,
  diff_hunk: Schema.String,
  in_reply_to_id: Schema.optional(Schema.Int),
  pull_request_url: Schema.String,
});
export type ReviewComment = typeof ReviewComment.Type;

export const PullRequest = Schema.Struct({
  /** The author's standing on the repository, in webhook payloads. */
  author_association: Schema.optional(Schema.String),
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  user: GitHubUser,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    /** Null when the fork was deleted. */
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
});
export type PullRequest = typeof PullRequest.Type;

const Installation = Schema.optional(Schema.Struct({ id: Schema.Int }));

const Envelope = { repository: Repository, sender: GitHubUser, installation: Installation };

export const IssueCommentEvent = Schema.Struct({
  action: Schema.String,
  comment: Comment,
  issue: Issue,
  ...Envelope,
});

export const PullRequestReviewCommentEvent = Schema.Struct({
  action: Schema.String,
  comment: ReviewComment,
  pull_request: PullRequest,
  ...Envelope,
});

export const PullRequestReviewEvent = Schema.Struct({
  action: Schema.String,
  review: Schema.Struct({
    id: Schema.Int,
    body: Schema.NullOr(Schema.String),
    state: Schema.String,
    html_url: Schema.String,
    user: GitHubUser,
    author_association: Schema.String,
  }),
  pull_request: PullRequest,
  ...Envelope,
});

export const IssuesEvent = Schema.Struct({
  action: Schema.String,
  issue: Issue,
  label: Schema.optional(Schema.Struct({ name: Schema.String })),
  assignee: Schema.optional(Schema.NullOr(GitHubUser)),
  ...Envelope,
});

export const PullRequestEvent = Schema.Struct({
  action: Schema.String,
  pull_request: PullRequest,
  ...Envelope,
});

/** Where a mention was found on the thread. */
export type MentionSource =
  | { readonly kind: "comment"; readonly id: number }
  | {
      readonly kind: "review_comment";
      readonly id: number;
      readonly path: string;
      readonly line: Option.Option<number>;
      readonly diffHunk: string;
      readonly commitId: string;
    }
  | { readonly kind: "review"; readonly id: number }
  /** The issue or pull request body itself, when opened. */
  | { readonly kind: "body" }
  | { readonly kind: "assignment" }
  | { readonly kind: "label" };

/**
 * A mention as every delivery path produces it: a webhook event, a polled
 * comment, or a label. Nothing downstream knows which way it came in.
 */
export interface Mention {
  readonly repository: {
    readonly owner: string;
    readonly repo: string;
    readonly isPrivate: boolean;
    readonly ownerIsOrganization: boolean;
    readonly defaultBranch: Option.Option<string>;
  };
  readonly installationId: Option.Option<number>;
  readonly target: {
    readonly kind: "issue" | "pull_request";
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly author: string;
    readonly state: string;
  };
  readonly pull: Option.Option<{
    readonly headRef: string;
    readonly headSha: string;
    /** The head's repository; not the target's when the pull request is from a fork. */
    readonly headRepo: Option.Option<string>;
    readonly baseRef: string;
  }>;
  readonly source: MentionSource;
  /** What the person wrote where the mention was; the issue body for an assignment or a label. */
  readonly text: string;
  readonly url: string;
  readonly author: {
    readonly id: number;
    readonly login: string;
    readonly isBot: boolean;
    readonly association: string;
  };
}

/** What the trigger test needs to know from the configuration. */
export interface TriggerRules {
  readonly mention: Option.Option<string>;
  readonly command: Option.Option<string>;
  readonly label: Option.Option<string>;
  readonly assignee: Option.Option<string>;
}

const splitFullName = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

const repositoryOf = (repository: Repository): Mention["repository"] => ({
  ...splitFullName(repository.full_name),
  isPrivate: repository.private,
  ownerIsOrganization: repository.owner.type === "Organization",
  defaultBranch: Option.fromNullishOr(repository.default_branch),
});

const authorOf = (user: GitHubUser, association: string): Mention["author"] => ({
  id: user.id,
  login: user.login,
  isBot: user.type !== "User",
  association,
});

const issueTarget = (issue: Issue): Mention["target"] => ({
  kind: issue.pull_request === undefined ? "issue" : "pull_request",
  number: issue.number,
  title: issue.title,
  body: issue.body ?? "",
  url: issue.html_url,
  author: issue.user.login,
  state: issue.state,
});

const pullTarget = (pull: PullRequest): Mention["target"] => ({
  kind: "pull_request",
  number: pull.number,
  title: pull.title,
  body: pull.body ?? "",
  url: pull.html_url,
  author: pull.user.login,
  state: pull.state,
});

/** The branches a mention on a pull request carries; what a comment on it has to look up. */
export const pullOf = (pull: PullRequest): Mention["pull"] =>
  Option.some({
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    headRepo: Option.map(Option.fromNullishOr(pull.head.repo), (repo) => repo.full_name),
    baseRef: pull.base.ref,
  });

/**
 * The bot answers what a reader can see: the trigger is looked for in the
 * text with the hidden markup already stripped, the same text the model is
 * given. A mention buried in an HTML comment would otherwise start a run
 * whose input no longer holds it.
 */
const addressed = (text: string, rules: TriggerRules): boolean =>
  triggered(stripHiddenMarkup(text), {
    mention: Option.getOrUndefined(rules.mention),
    command: Option.getOrUndefined(rules.command),
  });

const decode = <A>(schema: Schema.Codec<A>, payload: Schema.Json): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(payload);

/**
 * The trigger test, in order: the event and action are modelled, the
 * sender is a person (the bridge's own comments come back as a Bot and
 * would otherwise answer themselves), and the text addresses the bot, or
 * the assignee or label is the configured one. None when any step fails.
 */
export const mentionFrom = (
  event: string,
  payload: Schema.Json,
  rules: TriggerRules,
): Option.Option<Mention> => {
  switch (event) {
    case "issue_comment":
      return Option.flatMap(decode(IssueCommentEvent, payload), (body) => {
        if (body.action !== "created" || body.comment.user.type !== "User") {
          return Option.none();
        }
        if (!addressed(body.comment.body, rules)) {
          return Option.none();
        }
        return Option.some<Mention>({
          repository: repositoryOf(body.repository),
          installationId: Option.map(Option.fromNullishOr(body.installation), (i) => i.id),
          target: issueTarget(body.issue),
          pull: Option.none(),
          source: { kind: "comment", id: body.comment.id },
          text: body.comment.body,
          url: body.comment.html_url,
          author: authorOf(body.comment.user, body.comment.author_association),
        });
      });
    case "pull_request_review_comment":
      return Option.flatMap(decode(PullRequestReviewCommentEvent, payload), (body) => {
        if (body.action !== "created" || body.comment.user.type !== "User") {
          return Option.none();
        }
        if (!addressed(body.comment.body, rules)) {
          return Option.none();
        }
        return Option.some<Mention>({
          repository: repositoryOf(body.repository),
          installationId: Option.map(Option.fromNullishOr(body.installation), (i) => i.id),
          target: pullTarget(body.pull_request),
          pull: pullOf(body.pull_request),
          source: {
            kind: "review_comment",
            id: body.comment.id,
            path: body.comment.path,
            line: Option.fromNullishOr(body.comment.line),
            diffHunk: body.comment.diff_hunk,
            commitId: body.comment.commit_id,
          },
          text: body.comment.body,
          url: body.comment.html_url,
          author: authorOf(body.comment.user, body.comment.author_association),
        });
      });
    case "pull_request_review":
      return Option.flatMap(decode(PullRequestReviewEvent, payload), (body) => {
        const text = body.review.body ?? "";
        if (body.action !== "submitted" || body.review.user.type !== "User") {
          return Option.none();
        }
        if (!addressed(text, rules)) {
          return Option.none();
        }
        return Option.some<Mention>({
          repository: repositoryOf(body.repository),
          installationId: Option.map(Option.fromNullishOr(body.installation), (i) => i.id),
          target: pullTarget(body.pull_request),
          pull: pullOf(body.pull_request),
          source: { kind: "review", id: body.review.id },
          text,
          url: body.review.html_url,
          author: authorOf(body.review.user, body.review.author_association),
        });
      });
    case "issues":
      return Option.flatMap(decode(IssuesEvent, payload), (body) => {
        if (body.sender.type !== "User") {
          return Option.none();
        }
        const base = {
          repository: repositoryOf(body.repository),
          installationId: Option.map(Option.fromNullishOr(body.installation), (i) => i.id),
          target: issueTarget(body.issue),
          pull: Option.none(),
          text: body.issue.body ?? "",
          url: body.issue.html_url,
        };
        switch (body.action) {
          case "opened":
            return addressed(base.text, rules)
              ? Option.some<Mention>({
                  ...base,
                  source: { kind: "body" },
                  author: authorOf(body.issue.user, body.issue.author_association ?? "UNKNOWN"),
                })
              : Option.none();
          case "assigned": {
            const login = body.assignee?.login.toLowerCase();
            return Option.isSome(rules.assignee) &&
              login !== undefined &&
              login === rules.assignee.value.toLowerCase()
              ? Option.some<Mention>({
                  ...base,
                  source: { kind: "assignment" },
                  author: authorOf(body.sender, "UNKNOWN"),
                })
              : Option.none();
          }
          case "labeled":
            return Option.isSome(rules.label) && body.label?.name === rules.label.value
              ? Option.some<Mention>({
                  ...base,
                  source: { kind: "label" },
                  author: authorOf(body.sender, "UNKNOWN"),
                })
              : Option.none();
          default:
            return Option.none();
        }
      });
    case "pull_request":
      return Option.flatMap(decode(PullRequestEvent, payload), (body) => {
        const text = body.pull_request.body ?? "";
        if (body.action !== "opened" || body.pull_request.user.type !== "User") {
          return Option.none();
        }
        if (!addressed(text, rules)) {
          return Option.none();
        }
        return Option.some<Mention>({
          repository: repositoryOf(body.repository),
          installationId: Option.map(Option.fromNullishOr(body.installation), (i) => i.id),
          target: pullTarget(body.pull_request),
          pull: pullOf(body.pull_request),
          source: { kind: "body" },
          text,
          url: body.pull_request.html_url,
          author: authorOf(
            body.pull_request.user,
            body.pull_request.author_association ?? "UNKNOWN",
          ),
        });
      });
    default:
      return Option.none();
  }
};

/**
 * The conversation every mention on one issue or pull request continues:
 * owner and repository lowercased, since GitHub names are case-insensitive,
 * and `.` replaced, since a conversation id may not hold one.
 */
export const conversationIdFor = (mention: Mention): string =>
  [
    "github",
    mention.repository.owner,
    mention.repository.repo,
    mention.target.kind === "issue" ? "issue" : "pr",
    String(mention.target.number),
  ]
    .join("-")
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, "-");
