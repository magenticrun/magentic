import { DateTime, Effect, Option, Schema } from "effect";
import type { GitHubBridgeConfig } from "./Config.ts";
import {
  Comment,
  Issue,
  type Mention,
  mentionFrom,
  PullRequest,
  Repository,
  ReviewComment,
  type TriggerRules,
} from "./Events.ts";
import type { GitHubApi, GitHubAuth } from "./GitHubApi.ts";
import type { BridgeState } from "./State.ts";

export interface PollOptions {
  readonly api: GitHubApi["Service"];
  readonly config: GitHubBridgeConfig;
  readonly rules: TriggerRules;
  readonly state: BridgeState["Service"];
  readonly onMention: (mention: Mention) => Effect.Effect<void>;
}

const Installations = Schema.Array(Schema.Struct({ id: Schema.Int }));
const InstallationRepositories = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
});

const numberFrom = (url: string): Option.Option<number> => {
  // `Number("")` is 0, so a url with nothing after the last slash would ask
  // GitHub for issue 0; only a real number is one.
  const last = url.split("/").at(-1);
  const number = last === undefined || last === "" ? Number.NaN : Number(last);
  return Number.isInteger(number) && number > 0 ? Option.some(number) : Option.none();
};

/**
 * The fallback when no delivery reaches the gateway: one sweep over the
 * comments of each repository since the last sweep. It sees comments and
 * nothing else, so no assignment, label, or review envelope arrives this
 * way, and the trigger test is the webhook's, fed a payload shaped like
 * the event GitHub would have sent.
 */
export const pollOnce = (options: PollOptions) =>
  Effect.gen(function* () {
    const { api, config } = options;

    const repositories =
      config.repositories.length > 0
        ? config.repositories
        : yield* Effect.gen(function* () {
            const installations = yield* api.request({ _tag: "App" }, "GET", "/app/installations", {
              query: { per_page: "100" },
              schema: Installations,
            });
            const names: Array<string> = [];
            for (const installation of installations.body) {
              const listed = yield* api.request(
                { _tag: "Installation", installationId: installation.id },
                "GET",
                "/installation/repositories",
                { query: { per_page: "100" }, schema: InstallationRepositories },
              );
              names.push(...listed.body.repositories.map((repo) => repo.full_name));
            }
            return names;
          });

    for (const fullName of repositories) {
      yield* sweep(options, fullName).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`github bridge: sweep of ${fullName} failed: ${error.message}`),
        ),
      );
    }
    yield* Effect.annotateLogs(Effect.logDebug("github bridge: sweep done"), {
      repositories: repositories.length,
    });
  });

const sweep = (options: PollOptions, fullName: string) =>
  Effect.gen(function* () {
    const { api, state, rules } = options;
    const [owner = "", repo = ""] = fullName.split("/");
    const auth: GitHubAuth = { _tag: "Repository", owner, repo };
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const now = DateTime.formatIso(yield* DateTime.now);
    const since = yield* state.pollSince(fullName);
    if (Option.isNone(since)) {
      // The first sweep sets the watermark; what came before the bridge existed is not answered.
      yield* state.setPollSince(fullName, now);
      return;
    }
    const repository = (yield* api.request(auth, "GET", base, { schema: Repository })).body;
    const query = { since: since.value, sort: "updated", direction: "asc", per_page: "100" };
    const comments = yield* api.request(auth, "GET", `${base}/issues/comments`, {
      query,
      schema: Schema.Array(Comment),
    });
    const reviewComments = yield* api.request(auth, "GET", `${base}/pulls/comments`, {
      query,
      schema: Schema.Array(ReviewComment),
    });
    let latest = since.value;
    const advance = (at: string | undefined) => {
      if (at !== undefined && at > latest) {
        latest = at;
      }
    };

    for (const comment of comments.body) {
      advance(comment.updated_at);
      const number = numberFrom(comment.issue_url ?? "");
      if (Option.isNone(number) || comment.user.type !== "User") {
        continue;
      }
      if (yield* state.seenDelivery(`poll:comment:${comment.id}:${comment.updated_at ?? ""}`)) {
        continue;
      }
      const issue = yield* api.request(auth, "GET", `${base}/issues/${number.value}`, {
        schema: Issue,
      });
      const payload = {
        action: "created",
        comment,
        issue: issue.body,
        repository,
        sender: comment.user,
      };
      const mention = mentionFrom("issue_comment", toJson(payload), rules);
      if (Option.isSome(mention)) {
        yield* options.onMention(mention.value);
      }
    }

    for (const comment of reviewComments.body) {
      advance(comment.updated_at);
      const number = numberFrom(comment.pull_request_url);
      if (Option.isNone(number) || comment.user.type !== "User") {
        continue;
      }
      if (yield* state.seenDelivery(`poll:review:${comment.id}:${comment.updated_at ?? ""}`)) {
        continue;
      }
      const pull = yield* api.request(auth, "GET", `${base}/pulls/${number.value}`, {
        schema: PullRequest,
      });
      const payload = {
        action: "created",
        comment,
        pull_request: pull.body,
        repository,
        sender: comment.user,
      };
      const mention = mentionFrom("pull_request_review_comment", toJson(payload), rules);
      if (Option.isSome(mention)) {
        yield* options.onMention(mention.value);
      }
    }

    if (latest !== since.value) {
      yield* state.setPollSince(fullName, latest);
    }
  });

/** A decoded payload back to JSON, for the trigger test that decodes payloads. */
const toJson = <A>(value: A): Schema.Json =>
  // SAFETY: the value was decoded from JSON by the schemas above and holds nothing JSON cannot.
  JSON.parse(JSON.stringify(value)) as Schema.Json;
