import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";
import { accountIdOf, CodexAuthError, CodexTokens } from "./CodexTokens.ts";

const StoredFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), tokens: CodexTokens }),
);

const storage = (message: string) => new CodexAuthError({ reason: "Storage", message });

/** Where Codex tokens live between runs. The gateway and the CLI share one. */
export class CodexAuthStore extends Context.Service<
  CodexAuthStore,
  {
    readonly load: Effect.Effect<Option.Option<CodexTokens>, CodexAuthError>;
    save(tokens: CodexTokens): Effect.Effect<void, CodexAuthError>;
    readonly clear: Effect.Effect<void, CodexAuthError>;
  }
>()("magentic/model/CodexAuthStore") {
  /** Tokens held in memory only. For tests and one-off scripts. */
  static readonly layerMemory = (initial?: CodexTokens) =>
    Layer.effect(
      CodexAuthStore,
      Effect.gen(function* () {
        const ref = yield* Ref.make(Option.fromNullishOr(initial));
        return CodexAuthStore.of({
          load: Ref.get(ref),
          save: (tokens) => Ref.set(ref, Option.some(tokens)),
          clear: Ref.set(ref, Option.none()),
        });
      }),
    );

  /** A JSON file, mode 0600, created on first save. */
  static readonly layerFile = (file: string) =>
    Layer.effect(
      CodexAuthStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const load = Effect.gen(function* () {
          const exists = yield* fs.exists(file);
          if (!exists) {
            return Option.none<CodexTokens>();
          }
          const text = yield* fs.readFileString(file);
          const stored = yield* Schema.decodeEffect(StoredFile)(text);
          return Option.some(stored.tokens);
        }).pipe(Effect.mapError((error) => storage(`cannot read ${file}: ${error.message}`)));

        const save = Effect.fn("CodexAuthStore.save")(
          function* (tokens: CodexTokens) {
            yield* fs.makeDirectory(path.dirname(file), { recursive: true });
            const text = yield* Schema.encodeEffect(StoredFile)({ version: 1, tokens });
            yield* fs.writeFileString(file, text, { mode: 0o600 });
          },
          Effect.mapError((error) => storage(`cannot write ${file}: ${error.message}`)),
        );

        const clear = fs
          .remove(file, { force: true })
          .pipe(Effect.mapError((error) => storage(`cannot remove ${file}: ${error.message}`)));

        return CodexAuthStore.of({ load, save, clear });
      }),
    );
}

/** The shape the Codex CLI writes to `~/.codex/auth.json`. Only the fields we need. */
const CodexCliAuthFile = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({
      id_token: Schema.String,
      access_token: Schema.String,
      refresh_token: Schema.String,
      account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    last_refresh: Schema.DateTimeUtcFromString,
  }),
);

/**
 * Copies an existing Codex CLI login. The copy diverges from the CLI's from
 * then on: refresh tokens rotate, so the two must never refresh the same one.
 */
export const readCodexCliAuth = Effect.fn("CodexAuthStore.readCodexCliAuth")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => storage(`cannot read ${file}: ${error.message}`)));
  const parsed = yield* Schema.decodeEffect(CodexCliAuthFile)(text).pipe(
    Effect.mapError((error) => storage(`${file} is not a Codex auth file: ${error.message}`)),
  );
  const accountId = parsed.tokens.account_id ?? (yield* accountIdOf(parsed.tokens.id_token));
  return new CodexTokens({
    idToken: parsed.tokens.id_token,
    accessToken: parsed.tokens.access_token,
    refreshToken: parsed.tokens.refresh_token,
    accountId,
    lastRefresh: parsed.last_refresh,
  });
});
