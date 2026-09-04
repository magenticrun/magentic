import { dataDir } from "@magentic/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { Folded } from "./tui/Paste.ts";

/**
 * A message the person sent, as it stood in the composer: the draft with its
 * placeholders still in it, and what they stood for, so the up arrow brings
 * back what was typed rather than what was sent.
 */
export interface HistoryEntry {
  readonly draft: string;
  readonly folds: ReadonlyArray<Folded>;
}

/**
 * The same on disk. Only pasted text is kept: an image's bytes belong in the
 * message that carried them, not in a file every later session reads, so a
 * recalled message keeps its words and loses its images.
 */
const Remembered = Schema.Struct({
  draft: Schema.String,
  pastes: Schema.optional(
    Schema.Array(Schema.Struct({ placeholder: Schema.String, text: Schema.String })),
  ),
});
type Remembered = typeof Remembered.Type;

/**
 * What was typed where. The chat is per-directory — conversations are listed
 * by it — so the arrows walk back through this directory's own messages.
 */
const HistoryFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    directories: Schema.Record(Schema.String, Schema.Array(Remembered)),
  }),
);
type HistoryFile = typeof HistoryFile.Type;

/**
 * How much of one directory's past is kept: enough messages to walk back
 * through, and a size that a session's start-up read can afford. Whichever
 * runs out first drops the oldest.
 */
const MAX_ENTRIES = 200;
const MAX_CHARS = 256 * 1024;

const weigh = (entry: Remembered): number =>
  entry.draft.length + (entry.pastes ?? []).reduce((total, paste) => total + paste.text.length, 0);

/** The newest that fit, oldest first. */
const trim = (entries: ReadonlyArray<Remembered>): ReadonlyArray<Remembered> => {
  let total = 0;
  const kept: Array<Remembered> = [];
  // Back from the newest, taking what fits. The newest is kept whatever it
  // weighs: a person pasted it a moment ago and may well want it again.
  for (const entry of entries.slice(-MAX_ENTRIES).toReversed()) {
    total += weigh(entry);
    if (total > MAX_CHARS && kept.length > 0) {
      break;
    }
    kept.push(entry);
  }
  return kept.toReversed();
};

const toRemembered = (entry: HistoryEntry): Remembered => {
  const pastes = entry.folds.flatMap((fold) =>
    fold.kind === "text" ? [{ placeholder: fold.placeholder, text: fold.text }] : [],
  );
  return pastes.length === 0 ? { draft: entry.draft } : { draft: entry.draft, pastes };
};

const toEntry = (remembered: Remembered): HistoryEntry => ({
  draft: remembered.draft,
  folds: (remembered.pastes ?? []).map((paste) => ({
    kind: "text",
    placeholder: paste.placeholder,
    text: paste.text,
  })),
});

const historyFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* dataDir, "history.json");
});

const EMPTY: HistoryFile = { version: 1, directories: {} };

/** What is on disk, when the file is there and readable; a history nobody can read is an empty one. */
const read = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* historyFile;
  if (!(yield* fs.exists(file))) {
    return EMPTY;
  }
  return yield* Schema.decodeEffect(HistoryFile)(yield* fs.readFileString(file));
}).pipe(Effect.orElseSucceed(() => EMPTY));

/** The messages sent in this directory before, oldest first. */
export const loadHistory = Effect.fn("Cli.loadHistory")(function* (directory: string) {
  const held = yield* read;
  return (held.directories[directory] ?? []).map(toEntry);
});

/**
 * Keep one more message, at the end of this directory's history. The file is
 * re-read first, so a chat in another terminal that wrote meanwhile keeps its
 * messages. Sending the same text twice in a row remembers it once.
 */
export const appendHistory = Effect.fn("Cli.appendHistory")(function* (
  directory: string,
  entry: HistoryEntry,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* historyFile;
  const held = yield* read;
  const before = held.directories[directory] ?? [];
  if (before.at(-1)?.draft === entry.draft) {
    return;
  }
  const next: HistoryFile = {
    version: 1,
    directories: { ...held.directories, [directory]: trim([...before, toRemembered(entry)]) },
  };
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, yield* Schema.encodeEffect(HistoryFile)(next));
});
