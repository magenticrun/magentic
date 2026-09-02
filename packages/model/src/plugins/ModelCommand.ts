import {
  CommandError,
  type CommandInput,
  define,
  formatModelRef,
  type ModelInfo,
  type ModelProviderRegistration,
  parseModelRef,
  type Picked,
  type Picker,
  type PickItem,
} from "@magentic/plugin";
import { Effect, FileSystem, Option, Path, Ref, Schema } from "effect";

const NAME = "model";

const FavouritesFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), models: Schema.Array(Schema.String) }),
);

/** One provider with what the picker needs to know about it, read once per command run. */
interface ProviderView {
  readonly provider: ModelProviderRegistration;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly signedIn: boolean;
}

const FAVOURITE = { key: "f", label: "favourite" };

const failed = (message: string) => new CommandError({ command: NAME, message });

/**
 * `/model`: pick the model the chat runs on. Favourites come first, then the
 * signed-in providers; choosing a provider lists its models. `f` on a model row keeps
 * it in the favourites file for next time. `/model provider/model` sets it
 * outright.
 */
export const modelCommandPlugin = define<FileSystem.FileSystem | Path.Path>({
  id: "model-command",
  description: "The /model command: choose the model a chat runs on.",
  setup: Effect.fn("modelCommandPlugin.setup")(function* (ctx) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(ctx.paths.data, "favourites.json");

    /** Missing or unreadable favourites are an empty list; nothing here is worth failing for. */
    const loadFavourites: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) {
        return [];
      }
      const stored = yield* Schema.decodeEffect(FavouritesFile)(yield* fs.readFileString(file));
      return stored.models;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    const saveFavourites = Effect.fn("model.saveFavourites")(
      function* (models: ReadonlyArray<string>) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const text = yield* Schema.encodeEffect(FavouritesFile)({ version: 1, models });
        yield* fs.writeFileString(file, text);
      },
      Effect.mapError((error) => failed(`cannot write ${file}: ${error.message}`)),
    );

    const views = Effect.fn("model.views")(function* () {
      const out: Array<ProviderView> = [];
      for (const provider of yield* ctx.model.providers) {
        const models = yield* provider.models;
        const status = yield* provider.status.pipe(Effect.option, Effect.map(Option.flatten));
        out.push({ provider, models, signedIn: Option.isSome(status) });
      }
      return out;
    });

    /** The model a `provider/model` reference names, when both halves are known. */
    const lookup = (all: ReadonlyArray<ProviderView>, ref: string) => {
      const parsed = parseModelRef(ref);
      const view = all.find((v) => v.provider.id === parsed.provider);
      if (view === undefined) {
        return Option.none();
      }
      const id = Option.getOrElse(parsed.model, () => view.provider.defaultModel);
      const model = view.models.find((m) => m.id === id);
      return model === undefined ? Option.none() : Option.some({ view, model });
    };

    const run = Effect.fn("model.run")(function* ({ ui, session, args }: CommandInput) {
      // Only what can run: a provider nobody signed in to has nothing to offer here.
      const all = (yield* views()).filter((v) => v.signedIn);
      const favourites = yield* Ref.make(yield* loadFavourites);

      const choose = Effect.fn("model.choose")(function* (ref: string) {
        yield* session.setModel(ref);
        yield* ui.notify(`Model set to ${ref}`);
      });

      if (all.length === 0) {
        return yield* ui.notify("No provider is signed in; run `magentic auth login` first.");
      }

      if (args.length > 0) {
        const found = lookup(all, args);
        if (Option.isNone(found)) {
          const known = all.map((v) => v.provider.id).join(", ");
          return yield* failed(`no model "${args}"; signed-in providers: ${known}`);
        }
        return yield* choose(formatModelRef(found.value.view.provider.id, found.value.model.id));
      }

      const toggle = Effect.fn("model.toggle")(function* (ref: string) {
        const next = yield* Ref.modify(favourites, (current) => {
          const without = current.filter((m) => m !== ref);
          const updated = without.length === current.length ? [...current, ref] : without;
          return [updated, updated];
        });
        yield* saveFavourites(next);
      });

      const current = yield* session.model;
      const isCurrent = (ref: string) => Option.contains(current, ref);

      /** Favourites that still name a known provider and model, as picker rows. */
      const favouriteItems = Effect.map(Ref.get(favourites), (refs) =>
        refs.flatMap((ref): ReadonlyArray<PickItem> => {
          const found = lookup(all, ref);
          return Option.isNone(found)
            ? []
            : [
                {
                  id: ref,
                  label: found.value.model.name,
                  detail: found.value.view.provider.name,
                  marked: true,
                },
              ];
        }),
      );

      const topPicker = Effect.fn("model.topPicker")(function* (cursor: Option.Option<string>) {
        const items = yield* favouriteItems;
        const providers: ReadonlyArray<PickItem> = all.map((v) => ({
          id: `provider:${v.provider.id}`,
          label: v.provider.name,
        }));
        const picker: Picker = {
          title: "Select model",
          sections: [
            ...(items.length > 0 ? [{ title: "Favourites", items }] : []),
            { title: "Providers", items: providers },
          ],
          actions: [FAVOURITE],
          cursor: Option.getOrUndefined(
            Option.orElse(cursor, () =>
              Option.filter(current, (ref) => items.some((i) => i.id === ref)),
            ),
          ),
        };
        return picker;
      });

      const providerPicker = Effect.fn("model.providerPicker")(function* (
        view: ProviderView,
        cursor: Option.Option<string>,
      ) {
        const refs = yield* Ref.get(favourites);
        const items: ReadonlyArray<PickItem> = view.models.map((model) => {
          const ref = formatModelRef(view.provider.id, model.id);
          return {
            id: ref,
            label: model.name,
            detail: model.id === model.name ? undefined : model.id,
            marked: refs.includes(ref),
          };
        });
        const fallback =
          items.find((i) => isCurrent(i.id))?.id ??
          formatModelRef(view.provider.id, view.provider.defaultModel);
        const picker: Picker = {
          title: view.provider.name,
          sections: [{ title: "Models", items }],
          actions: [FAVOURITE],
          cursor: Option.getOrElse(cursor, () => fallback),
        };
        return picker;
      });

      /** Inside one provider until a model is chosen (true) or the person backs out (false). */
      const browseProvider = Effect.fn("model.browseProvider")(function* (view: ProviderView) {
        let cursor = Option.none<string>();
        while (true) {
          const picked: Option.Option<Picked> = yield* ui.pick(yield* providerPicker(view, cursor));
          if (Option.isNone(picked)) {
            return false;
          }
          if (Option.isSome(picked.value.action)) {
            yield* toggle(picked.value.id);
            cursor = Option.some(picked.value.id);
            continue;
          }
          yield* choose(picked.value.id);
          return true;
        }
      });

      let cursor = Option.none<string>();
      while (true) {
        const picked: Option.Option<Picked> = yield* ui.pick(yield* topPicker(cursor));
        if (Option.isNone(picked)) {
          return;
        }
        const { id, action } = picked.value;
        cursor = Option.some(id);
        if (id.startsWith("provider:")) {
          if (Option.isSome(action)) {
            continue;
          }
          const view = all.find((v) => `provider:${v.provider.id}` === id);
          if (view !== undefined && (yield* browseProvider(view))) {
            return;
          }
          continue;
        }
        if (Option.isSome(action)) {
          yield* toggle(id);
          continue;
        }
        return yield* choose(id);
      }
    });

    yield* ctx.command.register({
      name: NAME,
      description: "Choose the model this chat runs on",
      run,
    });
  }),
});
