import { ScheduledInboxRow, ScheduledTask } from "@magentic/protocol";
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";

export class ScheduledTaskStoreError extends Schema.TaggedError<ScheduledTaskStoreError>()(
  "ScheduledTaskStoreError",
  { conversationId: Schema.String, message: Schema.String },
) {}

/**
 * Bumped in the same commit that changes what a stored record means, with the
 * matching step added to `migrate`. A file written before versioning reads as
 * 0.
 */
export const SCHEDULE_SCHEMA_VERSION = 1;

/**
 * Everything one conversation has scheduled, and the fires waiting for a turn
 * to take them.
 *
 * Held together because they are written together: a fire is recorded and the
 * task moved on in one write, so a crash cannot leave a task that has advanced
 * past a slot whose fire was never stored.
 */
export const ScheduleFile = Schema.Struct({
  version: Schema.Finite,
  tasks: Schema.Array(ScheduledTask),
  /** Fires no run has taken yet, oldest first. */
  inbox: Schema.Array(ScheduledInboxRow),
});
export type ScheduleFile = typeof ScheduleFile.Type;

export const emptyFile: ScheduleFile = {
  version: SCHEDULE_SCHEMA_VERSION,
  tasks: [],
  inbox: [],
};

/**
 * A file from an older version, brought forward. Nothing to do yet — the
 * first version is the current one — but the seam is here so that the next
 * change migrates what it can rather than disarming every stored loop, which
 * is what failing closed on the whole file would do.
 */
const migrate = (file: ScheduleFile): Option.Option<ScheduleFile> =>
  file.version === SCHEDULE_SCHEMA_VERSION ? Option.some(file) : Option.none();

/**
 * Where a conversation's schedules live between runs.
 *
 * The store is the truth and the timers are derived from it: a fiber can be
 * interrupted at any moment, and what it was going to do next has to be
 * readable from disk afterwards. Reading a file that cannot be understood
 * gives back nothing and says so, rather than quietly reading as "no
 * schedules" — which would arm nothing while the person believes a loop is
 * running.
 */
export class ScheduledTaskStore extends Context.Service<
  ScheduledTaskStore,
  {
    /** None when the conversation never had one; fails when it has one that cannot be read. */
    read(conversationId: string): Effect.Effect<ScheduleFile, ScheduledTaskStoreError>;
    write(conversationId: string, file: ScheduleFile): Effect.Effect<void, ScheduledTaskStoreError>;
    /** Every conversation with something scheduled, for arming on start-up. */
    readonly conversations: Effect.Effect<ReadonlyArray<string>>;
    remove(conversationId: string): Effect.Effect<void, ScheduledTaskStoreError>;
  }
>()("magentic/core/ScheduledTaskStore") {
  /** Lost on restart. Fine for tests. */
  static readonly layerMemory = Layer.effect(
    ScheduledTaskStore,
    Effect.gen(function* () {
      const files = yield* Ref.make(new Map<string, ScheduleFile>());
      return ScheduledTaskStore.of({
        read: (conversationId) =>
          Effect.map(Ref.get(files), (all) => all.get(conversationId) ?? emptyFile),
        write: (conversationId, file) =>
          Ref.update(files, (all) => new Map(all).set(conversationId, file)),
        conversations: Effect.map(Ref.get(files), (all) =>
          [...all.entries()]
            .filter(([, file]) => file.tasks.length > 0 || file.inbox.length > 0)
            .map(([id]) => id),
        ),
        remove: (conversationId) =>
          Ref.update(files, (all) => {
            const next = new Map(all);
            next.delete(conversationId);
            return next;
          }),
      });
    }),
  );

  /**
   * `scheduled-tasks.json` beside the conversation's own files, under the same
   * per-conversation directory, so removing a conversation removes its
   * schedules with it.
   */
  static readonly layerFile = (dir: string) =>
    Layer.effect(
      ScheduledTaskStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const FileJson = Schema.fromJsonString(ScheduleFile);
        const decodeFile = Schema.decodeEffect(FileJson);
        const encodeFile = Schema.encodeEffect(FileJson);
        const scheduleFile = (id: string) => path.join(dir, id, "scheduled-tasks.json");

        /** The wire schema already refuses these; the store refuses them again because it owns the disk. */
        const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
        const safe = (conversationId: string) =>
          SAFE_ID.test(conversationId)
            ? Effect.void
            : Effect.fail(
                new ScheduledTaskStoreError({
                  conversationId,
                  message: `${conversationId} is not a valid conversation id`,
                }),
              );

        const failed = (conversationId: string, message: string) =>
          new ScheduledTaskStoreError({ conversationId, message });

        const read = Effect.fn("ScheduledTaskStore.read")(function* (conversationId: string) {
          yield* safe(conversationId);
          const file = scheduleFile(conversationId);
          if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
            return emptyFile;
          }
          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.mapError(() => failed(conversationId, "its schedules could not be read")));
          const decoded = yield* decodeFile(text).pipe(
            Effect.mapError(() =>
              failed(conversationId, "its schedules are not in a shape this version understands"),
            ),
          );
          const brought = migrate(decoded);
          if (Option.isNone(brought)) {
            return yield* failed(
              conversationId,
              `its schedules were written by version ${decoded.version}, which this version cannot read`,
            );
          }
          return brought.value;
        });

        const write = Effect.fn("ScheduledTaskStore.write")(function* (
          conversationId: string,
          file: ScheduleFile,
        ) {
          yield* safe(conversationId);
          const target = scheduleFile(conversationId);
          const text = yield* encodeFile({ ...file, version: SCHEDULE_SCHEMA_VERSION }).pipe(
            Effect.mapError(() => failed(conversationId, "its schedules could not be written")),
          );
          // Written beside and renamed over, as the conversation's own files
          // are: a crash mid-write would otherwise leave a file that reads as
          // unintelligible, which arms nothing.
          const staging = `${target}.${crypto.randomUUID().slice(0, 8)}.tmp`;
          yield* fs
            .makeDirectory(path.join(dir, conversationId), { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(fs.writeFileString(staging, text, { mode: 0o600 })),
              Effect.andThen(fs.rename(staging, target)),
              Effect.onError(() => fs.remove(staging).pipe(Effect.ignore)),
              Effect.mapError(() => failed(conversationId, "its schedules could not be written")),
            );
        });

        const conversations = Effect.gen(function* () {
          const entries = yield* fs.readDirectory(dir);
          const found: Array<string> = [];
          for (const entry of entries) {
            const has = yield* fs
              .exists(scheduleFile(entry))
              .pipe(Effect.orElseSucceed(() => false));
            if (has) {
              found.push(entry);
            }
          }
          return found;
        }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

        const remove = Effect.fn("ScheduledTaskStore.remove")(function* (conversationId: string) {
          yield* safe(conversationId);
          yield* fs.remove(scheduleFile(conversationId)).pipe(Effect.ignore);
        });

        return ScheduledTaskStore.of({ read, write, conversations, remove });
      }),
    );
}
