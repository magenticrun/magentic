import type { AnswerDelivery } from "@magentic/plugin";
import { Config, Option, Redacted, Schema } from "effect";

/** The `plugins.use` entry for the bridge, as `magentic.yaml` writes it. Secrets are not here. */
export class GitHubBridgeOptions extends Schema.Class<GitHubBridgeOptions>(
  "magentic/bridge-github/Options",
)({
  /** The GitHub App that is the bot. `slug` is what people type after `@`. */
  app: Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThan(0)),
    slug: Schema.NonEmptyString,
  }),
  /** `https://api.github.com` unless this is GitHub Enterprise Server. */
  api: Schema.optional(Schema.String),
  /** How mentions arrive: the webhook at `/plugins/github/webhook`, or a sweep of comments a minute. */
  delivery: Schema.optional(Schema.Literals(["webhook", "poll"])),
  /** Repositories the poller sweeps, as `owner/repo`; every installation repository when absent. */
  repositories: Schema.optional(Schema.Array(Schema.String)),
  /** The agent a mention runs; `github` by default. */
  agent: Schema.optional(Schema.NonEmptyString),
  trigger: Schema.optional(
    Schema.Struct({
      /** Whether `@<slug>` in a comment triggers a run. */
      mention: Schema.optional(Schema.Boolean),
      /** A slash command that triggers one too, for the people whose autocomplete never learns the bot. */
      command: Schema.optional(Schema.NullOr(Schema.String)),
      /** A label whose addition to an issue triggers a run on it. */
      label: Schema.optional(Schema.NullOr(Schema.String)),
      /** A login whose assignment to an issue triggers a run, since an App cannot be an assignee. */
      assignee: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  allow: Schema.optional(
    Schema.Struct({
      /** The repository permission a person needs; `write` by default. */
      minimum: Schema.optional(Schema.Literals(["admin", "write", "read"])),
      /** Logins admitted whatever their permission: external maintainers. */
      logins: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  public: Schema.optional(
    Schema.Struct({
      /** Whether mentions on public repositories are answered at all; off by default. */
      admit: Schema.optional(Schema.Boolean),
    }),
  ),
  branch: Schema.optional(
    Schema.Struct({
      /** The namespace the bot may push to besides a pull request's own branch; `magentic/` by default. */
      prefix: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  poll: Schema.optional(
    Schema.Struct({
      /** Seconds between sweeps; sixty by default. */
      interval: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
  progress: Schema.optional(
    Schema.Struct({
      /**
       * What becomes of the progress comment once the answer is posted.
       * Absent, the bridge's own capabilities decide, which on GitHub means
       * `collapse`: a comment is mailed when it is created and never again,
       * so an answer edited into the progress comment would reach only
       * whoever opens the thread.
       */
      after: Schema.optional(Schema.Literals(["edit", "collapse", "delete", "keep"])),
    }),
  ),
}) {}

/** The options with every default filled in, as the plugin reads them. */
export interface GitHubBridgeConfig {
  readonly appId: number;
  readonly slug: string;
  readonly apiUrl: string;
  readonly delivery: "webhook" | "poll";
  readonly repositories: ReadonlyArray<string>;
  readonly agent: string;
  readonly trigger: {
    readonly mention: boolean;
    readonly command: Option.Option<string>;
    readonly label: Option.Option<string>;
    readonly assignee: Option.Option<string>;
  };
  readonly allow: {
    readonly minimum: "admin" | "write" | "read";
    readonly logins: ReadonlySet<string>;
  };
  readonly admitPublic: boolean;
  readonly branchPrefix: string;
  readonly pollIntervalSeconds: number;
  /** What happens to the progress comment when the answer lands; absent leaves it to the surface's capabilities. */
  readonly progressAfter: Option.Option<AnswerDelivery>;
}

export const resolveConfig = (options: GitHubBridgeOptions): GitHubBridgeConfig => ({
  appId: options.app.id,
  slug: options.app.slug,
  apiUrl: options.api ?? "https://api.github.com",
  delivery: options.delivery ?? "webhook",
  repositories: options.repositories ?? [],
  agent: options.agent ?? "github",
  trigger: {
    mention: options.trigger?.mention ?? true,
    command: Option.fromNullishOr(options.trigger?.command ?? "/magentic"),
    label: Option.fromNullishOr(options.trigger?.label),
    assignee: Option.fromNullishOr(options.trigger?.assignee),
  },
  allow: {
    minimum: options.allow?.minimum ?? "write",
    logins: new Set((options.allow?.logins ?? []).map((login) => login.toLowerCase())),
  },
  admitPublic: options.public?.admit ?? false,
  branchPrefix: options.branch?.prefix ?? "magentic/",
  pollIntervalSeconds: options.poll?.interval ?? 60,
  progressAfter: Option.fromNullishOr(options.progress?.after),
});

/**
 * The App's private key, as GitHub issued it. An environment variable cannot
 * hold a newline in every shell, so `\n` in the value stands for one.
 */
export const privateKey = Config.redacted("GITHUB_APP_PRIVATE_KEY").pipe(
  Config.map((key) => Redacted.make(Redacted.value(key).replaceAll("\\n", "\n"))),
);

/** What GitHub signs webhook deliveries with; absent means the webhook route refuses every delivery. */
export const webhookSecret = Config.redacted("GITHUB_WEBHOOK_SECRET").pipe(Config.option);
