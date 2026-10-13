import type { Conversation, TranscriptEntry } from "@magentic/protocol";
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ConversationStore } from "./ConversationStore.ts";
import { transcriptFromJson } from "./Transcript.ts";

export class SessionIndexError extends Schema.TaggedError<SessionIndexError>()(
  "SessionIndexError",
  { message: Schema.String },
) {}

/** Which part of a conversation a hit is in: what was said, a summary, or a tool call's arguments. */
export const SessionRole = Schema.Literals(["user", "assistant", "summary", "tool"]);
export type SessionRole = typeof SessionRole.Type;

export const SessionHit = Schema.Struct({
  /** The entry's position in the conversation's transcript, for `session_read`. */
  entry: Schema.Finite,
  role: SessionRole,
  /** The matching words in «», with some of the text around them. */
  snippet: Schema.String,
});

export const SessionMatch = Schema.Struct({
  conversationId: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  directory: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
  hits: Schema.Array(SessionHit),
});
export type SessionMatch = typeof SessionMatch.Type;

/**
 * Full-text search over a person's past conversations, kept in step with the
 * ConversationStore it wraps. The histories stay the record; the index is
 * derived from them, so it can be dropped and rebuilt at any time.
 */
export class SessionIndex extends Context.Service<
  SessionIndex,
  {
    /**
     * The conversations of `principal` whose words match `query`, best first.
     * A query is words, any of them in "quotes" to keep together as a phrase;
     * every word must match, unless none does with all of them, when any may.
     */
    search(
      principal: string,
      query: string,
      options: { readonly limit: number; readonly exclude?: string },
    ): Effect.Effect<ReadonlyArray<SessionMatch>, SessionIndexError>;
  }
>()("magentic/core/SessionIndex") {
  /**
   * The index in the SQL database, and the ConversationStore it wraps: a save
   * indexes the conversation anew, an update its details, a removal takes it
   * out. Conversations saved while the gateway was not running are indexed
   * in the background once it starts.
   */
  static readonly layer = Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const inner = yield* ConversationStore;
      yield* migrate(sql).pipe(
        Effect.mapError((error) => new SessionIndexError({ message: error.message })),
      );

      const writeDetails = (info: Conversation) => {
        const updatedAt = DateTime.formatIso(info.updatedAt);
        return sql`INSERT INTO session_conversations (id, principal, title, agent, directory, updated_at, messages)
          VALUES (${info.id}, ${info.principal}, ${info.title}, ${info.agent}, ${info.directory ?? null}, ${updatedAt}, ${info.messages})
          ON CONFLICT (id) DO UPDATE SET principal = excluded.principal, title = excluded.title,
            agent = excluded.agent, directory = excluded.directory, updated_at = excluded.updated_at,
            messages = excluded.messages`;
      };

      const index = Effect.fn("SessionIndex.index")(function* (info: Conversation, json: string) {
        const rows = searchableRows(info.id, yield* transcriptFromJson(json));
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM session_entries WHERE conversation = ${info.id}`;
            yield* writeDetails(info);
            for (let at = 0; at < rows.length; at += INSERT_BATCH) {
              yield* sql`INSERT INTO session_entries ${sql.insert(rows.slice(at, at + INSERT_BATCH))}`;
            }
          }),
        );
      });

      const forget = Effect.fn("SessionIndex.forget")(function* (id: string) {
        yield* sql.withTransaction(
          Effect.andThen(
            sql`DELETE FROM session_entries WHERE conversation = ${id}`,
            sql`DELETE FROM session_conversations WHERE id = ${id}`,
          ),
        );
      });

      /** The index trails the store, never the other way round: a write it misses is logged, not failed. */
      const quietly = <E>(effect: Effect.Effect<void, E>, what: string) =>
        effect.pipe(
          Effect.catchCause((cause) => Effect.logWarning(`session index: ${what}`, cause)),
        );

      /**
       * What changed while nothing was watching: conversations newer than
       * their indexed copy, or never indexed, and index rows whose
       * conversation is gone.
       */
      const catchUp = Effect.gen(function* () {
        const indexed = yield* sql`SELECT id, updated_at, messages FROM session_conversations`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(IndexedRow))),
        );
        const known = new Map(indexed.map((row) => [row.id, row]));
        const stored = yield* inner.list;
        for (const info of stored) {
          const row = known.get(info.id);
          known.delete(info.id);
          if (
            row !== undefined &&
            row.updated_at === DateTime.formatIso(info.updatedAt) &&
            row.messages === info.messages
          ) {
            continue;
          }
          const history = yield* inner.history(info.id);
          if (Option.isSome(history)) {
            yield* quietly(index(info, history.value), `conversation ${info.id} not indexed`);
          }
        }
        for (const id of known.keys()) {
          yield* quietly(forget(id), `conversation ${id} not removed`);
        }
      });
      yield* quietly(catchUp, "catching up with the stored conversations failed").pipe(
        Effect.forkScoped,
      );

      const store = ConversationStore.of({
        ...inner,
        save: Effect.fn("ConversationStore.save")(function* (info, json) {
          yield* inner.save(info, json);
          yield* quietly(index(info, json), `conversation ${info.id} not indexed`);
        }),
        update: Effect.fn("ConversationStore.update")(function* (info) {
          yield* inner.update(info);
          yield* quietly(writeDetails(info), `conversation ${info.id} not updated`);
        }),
        remove: Effect.fn("ConversationStore.remove")(function* (id) {
          yield* inner.remove(id);
          yield* quietly(forget(id), `conversation ${id} not removed`);
        }),
      });

      const search = Effect.fn("SessionIndex.search")(
        function* (
          principal: string,
          query: string,
          options: { readonly limit: number; readonly exclude?: string },
        ) {
          const groups = phrases(query);
          if (groups.length === 0) {
            return [];
          }
          const run = (match: string) =>
            sql`SELECT session_entries.conversation AS conversation, session_entries.entry AS entry,
                session_entries.role AS role,
                snippet(session_entries, 0, '«', '»', '…', ${SNIPPET_TOKENS}) AS snippet,
                session_conversations.title AS title, session_conversations.agent AS agent,
                session_conversations.directory AS directory, session_conversations.updated_at AS updated_at
              FROM session_entries
              JOIN session_conversations ON session_conversations.id = session_entries.conversation
              WHERE session_entries MATCH ${match}
                AND session_conversations.principal = ${principal}
                AND session_conversations.id <> ${options.exclude ?? ""}
              ORDER BY bm25(session_entries)
              LIMIT ${HITS_SCANNED}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HitRow))),
            );
          const all = yield* run(groups.join(" "));
          const rows =
            all.length > 0 || groups.length === 1 ? all : yield* run(groups.join(" OR "));
          return grouped(rows, options.limit);
        },
        Effect.mapError((error) => new SessionIndexError({ message: error.message })),
      );

      return Context.make(ConversationStore, store).pipe(
        Context.add(SessionIndex, SessionIndex.of({ search })),
      );
    }),
  );

  /** For where there is no database, tests among them: searching says so. */
  static readonly layerUnavailable = (reason: string) =>
    Layer.succeed(
      SessionIndex,
      SessionIndex.of({
        search: () =>
          Effect.fail(
            new SessionIndexError({ message: `session search is unavailable: ${reason}` }),
          ),
      }),
    );
}

/**
 * The index is derived from the histories, so a change to its shape drops
 * and rebuilds it rather than migrating it; the catch-up refills it.
 */
const SCHEMA_VERSION = 1;

const migrate = Effect.fn("SessionIndex.migrate")(function* (sql: SqlClient.SqlClient) {
  const [current] = yield* sql`PRAGMA user_version`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Finite }))),
    ),
  );
  if (current?.user_version === SCHEMA_VERSION) {
    return;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP TABLE IF EXISTS session_entries`;
      yield* sql`DROP TABLE IF EXISTS session_conversations`;
      yield* sql`CREATE TABLE session_conversations (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        directory TEXT,
        updated_at TEXT NOT NULL,
        messages INTEGER NOT NULL
      )`;
      yield* sql`CREATE INDEX session_conversations_principal ON session_conversations (principal)`;
      // Stemmed so "deploying" finds "deploy", with accents folded.
      yield* sql`CREATE VIRTUAL TABLE session_entries USING fts5(
        text, conversation UNINDEXED, entry UNINDEXED, role UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      )`;
      yield* sql.unsafe(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }),
  );
});

const IndexedRow = Schema.Struct({
  id: Schema.String,
  updated_at: Schema.String,
  messages: Schema.Finite,
});

const HitRow = Schema.Struct({
  conversation: Schema.String,
  entry: Schema.Finite,
  role: SessionRole,
  snippet: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  directory: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
});

/** Rows one insert statement carries; four values each stays far below SQLite's limit on them. */
const INSERT_BATCH = 200;

/** Characters of one entry the index keeps: a pasted log should not crowd out everything else. */
const MAX_ENTRY_CHARS = 16_000;

/**
 * Characters of one tool call's arguments the index keeps: enough for a
 * command, a path, or a URL, where a file's new contents would otherwise
 * bury what was said.
 */
const MAX_TOOL_CHARS = 500;

/** Words a snippet shows around what matched. */
const SNIPPET_TOKENS = 24;

/** Matching entries read before grouping them by conversation. */
const HITS_SCANNED = 60;

/** Hits shown for one conversation; past this they repeat what the first ones said. */
const HITS_PER_CONVERSATION = 3;

/**
 * What of a transcript is searchable: what the person and the agent said,
 * the summaries compactions left, and which tools were called with what.
 * Tool results stay out: they are long, and much of what they hold came from
 * outside the conversation.
 */
const searchableRows = (conversation: string, transcript: ReadonlyArray<TranscriptEntry>) =>
  transcript.flatMap((entry, at) => {
    const found = searchable(entry);
    return found === undefined
      ? []
      : [{ text: found.text.slice(0, MAX_ENTRY_CHARS), conversation, entry: at, role: found.role }];
  });

const searchable = (
  entry: TranscriptEntry,
): { readonly role: SessionRole; readonly text: string } | undefined => {
  switch (entry._tag) {
    case "User":
      return { role: "user", text: entry.text };
    case "Assistant":
      return { role: "assistant", text: entry.text };
    case "Summary":
      return { role: "summary", text: entry.text };
    case "Tool":
      return {
        role: "tool",
        text: `${entry.name} ${leaves(entry.params).join(" ")}`.slice(0, MAX_TOOL_CHARS),
      };
    default:
      return undefined;
  }
};

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** The values in a tool call's arguments, without the JSON around them. */
const leaves = (value: Schema.Json): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return value.flatMap(leaves);
  }
  if (isJsonObject(value)) {
    return Object.values(value).flatMap(leaves);
  }
  return value === null ? [] : [String(value)];
};

/**
 * A query as FTS5 phrases: each "quoted" part, and each run of text between
 * spaces, becomes one phrase of its words, so `sql-sqlite-bun` matches those
 * three words together. Only letters and digits reach FTS5, so nothing typed
 * can be read as its query syntax.
 */
const phrases = (query: string): ReadonlyArray<string> =>
  [...query.matchAll(/"([^"]*)"|(\S+)/g)].flatMap((part) => {
    const words = (part[1] ?? part[2] ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
    return words.length === 0 ? [] : [`"${words.join(" ")}"`];
  });

/** Hits by conversation, in the order of each conversation's best one. */
const grouped = (
  rows: ReadonlyArray<typeof HitRow.Type>,
  limit: number,
): ReadonlyArray<SessionMatch> => {
  const byConversation = new Map<
    string,
    { info: typeof HitRow.Type; hits: Array<typeof SessionHit.Type> }
  >();
  for (const row of rows) {
    const found = byConversation.get(row.conversation);
    if (found === undefined) {
      if (byConversation.size === limit) {
        continue;
      }
      byConversation.set(row.conversation, {
        info: row,
        hits: [{ entry: row.entry, role: row.role, snippet: row.snippet }],
      });
    } else if (found.hits.length < HITS_PER_CONVERSATION) {
      found.hits.push({ entry: row.entry, role: row.role, snippet: row.snippet });
    }
  }
  const matches: Array<SessionMatch> = [];
  for (const { info, hits } of byConversation.values()) {
    const match = {
      conversationId: info.conversation,
      title: info.title,
      agent: info.agent,
      updatedAt: info.updated_at,
      hits: hits.toSorted((a, b) => a.entry - b.entry),
    };
    matches.push(info.directory === null ? match : { ...match, directory: info.directory });
  }
  return matches;
};
