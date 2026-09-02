import {
  type AgentDefinition,
  type AgentDraft,
  AgentAlreadyRegistered,
  capabilityOf,
  type ModelProviderRegistration,
  type Plugin,
  type PluginContext,
  type PluginPaths,
  type PluginServices,
  PluginSetupError,
  type Registration,
  type RunEventEnvelope,
  type ToolCallContext,
  type ToolHooks,
  type ToolServices,
} from "@magentic/plugin";
import { AgentNotFound, PluginInfo, type PluginSource, type RunEvent } from "@magentic/protocol";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  type Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";
import { AgentRegistry } from "../AgentRegistry.ts";
import { describeCause } from "../Errors.ts";
import { RunEventBus } from "../EventBus.ts";
import { modelRegistryOver, ModelRegistry } from "./ModelRegistry.ts";
import { openRegistry, type PluginRef, type Registry } from "./Registry.ts";
import {
  toolRegistryOver,
  ToolCallGuard,
  type ToolEntry,
  type ToolHookEntry,
  ToolRegistry,
} from "./ToolRegistry.ts";

/** A plugin together with where it came from and the options the config gave it. */
export interface LoadedPlugin<R = never> {
  readonly plugin: Plugin<R>;
  readonly source: PluginSource;
  readonly options?: Schema.Json;
}

/** Marks a plugin we ship. */
export const builtin = <R>(plugin: Plugin<R>): LoadedPlugin<R> => ({ plugin, source: "builtin" });

/** The services a list of loaded plugins needs, as one union. */
export type PluginRequirements<Plugins extends ReadonlyArray<LoadedPlugin<any>>> =
  Plugins[number] extends LoadedPlugin<infer R> ? Exclude<R, Scope.Scope> : never;

export interface PluginHostOptions<Plugins extends ReadonlyArray<LoadedPlugin<any>>> {
  /** In the order they set up, which is the order their contributions take. */
  readonly plugins: Plugins;
  /** Plugin ids that are skipped entirely. */
  readonly disabled?: ReadonlyArray<string>;
  /** Tool names hidden from every agent. */
  readonly disabledTools?: ReadonlyArray<string>;
  readonly paths: PluginPaths;
}

type AgentTransform = (draft: AgentDraft) => Effect.Effect<void>;

interface PluginState {
  readonly id: string;
  readonly description: string;
  readonly source: PluginSource;
  readonly status: "active" | "disabled" | "failed";
  readonly error?: string;
}

/**
 * Loads plugins and owns what they register. Every other registry is a view
 * over this one, so the gateway builds this layer and gets tools, model
 * providers, agents, and the run event bus with it.
 */
export class PluginHost extends Context.Service<
  PluginHost,
  {
    /** One row per plugin the host was given, with what each contributed. */
    readonly plugins: Effect.Effect<ReadonlyArray<PluginInfo>>;
  }
>()("magentic/core/PluginHost") {
  static readonly layer = <const Plugins extends ReadonlyArray<LoadedPlugin<any>>>(
    options: PluginHostOptions<Plugins>,
  ): Layer.Layer<
    PluginHost | ToolRegistry | ModelRegistry | AgentRegistry | RunEventBus,
    never,
    PluginRequirements<Plugins> | PluginServices | ToolCallGuard
  > =>
    Layer.effectContext(
      Effect.gen(function* () {
        const hostScope = yield* Scope.Scope;
        const guard = yield* ToolCallGuard;
        const bus = yield* RunEventBus.make;
        const disabled = new Set(options.disabled ?? []);

        // Agents: transforms replay into a fresh draft on every rebuild.
        const agents = yield* Ref.make<ReadonlyMap<string, AgentDefinition>>(new Map());
        const owners = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
        const booting = yield* Ref.make(true);
        const rebuildLock = yield* Semaphore.make(1);
        let transforms: Registry<AgentTransform>;

        const replay = Effect.gen(function* () {
          const draft = new Map<string, AgentDefinition>();
          const owner = new Map<string, string>();
          for (const entry of yield* transforms.entries) {
            const view: AgentDraft = {
              list: () => [...draft.values()],
              get: (name) => Option.fromNullishOr(draft.get(name)),
              set: (agent) => {
                draft.set(agent.name, agent);
                owner.set(agent.name, entry.plugin.id);
              },
              update: (name, f) => {
                const current = draft.get(name);
                if (current !== undefined) {
                  draft.set(name, f(current));
                }
              },
              remove: (name) => {
                draft.delete(name);
                owner.delete(name);
              },
            };
            yield* entry.value(view);
          }
          yield* Ref.set(agents, draft);
          yield* Ref.set(owners, owner);
        });
        const rebuild = rebuildLock.withPermit(replay);
        const rebuildUnlessBooting = Effect.gen(function* () {
          if (!(yield* Ref.get(booting))) {
            yield* rebuild;
          }
        });
        transforms = yield* openRegistry<AgentTransform>(rebuildUnlessBooting);

        const tools = yield* openRegistry<ToolEntry>();
        const toolHooks = yield* openRegistry<ToolHookEntry>();
        const providers = yield* openRegistry<ModelProviderRegistration>();

        const registerToolkit = <Tools extends Record<string, Tool.Any>>(
          ref: PluginRef,
          toolkit: Toolkit.WithHandler<Tools>,
        ): Effect.Effect<
          Registration,
          PluginSetupError,
          Scope.Scope | Exclude<ToolServices<Tools>, ToolCallContext>
        > =>
          Effect.gen(function* () {
            // Captured now so a call later runs with the plugin's own services.
            const services = yield* Effect.context<Exclude<ToolServices<Tools>, ToolCallContext>>();
            const taken = new Set((yield* tools.values).map((entry) => entry.tool.name));
            const registrations: Array<Registration> = [];
            for (const [name, tool] of Object.entries(toolkit.tools)) {
              const capability = capabilityOf(tool);
              if (capability === "none") {
                return yield* new PluginSetupError({
                  plugin: ref.id,
                  message: `tool ${name} declares no capability`,
                });
              }
              if (taken.has(name)) {
                return yield* new PluginSetupError({
                  plugin: ref.id,
                  message: `tool ${name} is already registered by another plugin`,
                });
              }
              taken.add(name);
              // SAFETY: `name` came from the keys of `toolkit.tools`.
              const key = name as keyof Tools;
              const bound = (params: Schema.Json, callId: string) => {
                // SAFETY: the params are the JSON the model sent for this very tool.
                const encoded = params as Tool.ParametersEncoded<Tools[keyof Tools]>;
                // The toolkit forks the handler inside this effect, so the services go here.
                return toolkit
                  .handle(key, encoded, callId)
                  .pipe(
                    Effect.provideContext(services),
                    Effect.map(Stream.provideContext(services)),
                  );
              };
              // SAFETY: the captured context covers every handler service except ToolCallContext,
              // which the registry provides on each call.
              const handle = bound as ToolEntry["handle"];
              registrations.push(
                yield* tools.register(ref, { plugin: ref.id, tool, capability, handle }),
              );
            }
            return {
              dispose: Effect.forEach(registrations, (r) => r.dispose, { discard: true }),
            };
          });

        const contextFor = (ref: PluginRef, loaded: LoadedPlugin<any>): PluginContext => ({
          options: loaded.options ?? {},
          paths: options.paths,
          tool: {
            registerToolkit: (toolkit) => registerToolkit(ref, toolkit),
            hook: <Name extends keyof ToolHooks>(
              name: Name,
              handler: (event: ToolHooks[Name]) => Effect.Effect<void>,
            ) =>
              // SAFETY: `name` selects the matching event type by construction of ToolHooks.
              toolHooks.register(ref, { name, handler } as ToolHookEntry),
          },
          model: { register: (provider) => providers.register(ref, provider) },
          agent: { transform: (apply) => transforms.register(ref, apply), rebuild },
          event: {
            subscribe: <Tag extends RunEvent["_tag"]>(tag: Tag) =>
              bus.stream.pipe(
                Stream.filter(
                  (
                    envelope,
                  ): envelope is RunEventEnvelope & {
                    readonly event: Extract<RunEvent, { _tag: Tag }>;
                  } => envelope.event._tag === tag,
                ),
              ),
          },
        });

        // Boot: set every plugin up in order, then build the agents once.
        const states: Array<PluginState> = [];
        const seen = new Set<string>();
        for (const [order, loaded] of options.plugins.entries()) {
          const { id, description } = loaded.plugin;
          const base = { id, description, source: loaded.source };
          if (disabled.has(id)) {
            states.push({ ...base, status: "disabled" });
            continue;
          }
          if (seen.has(id)) {
            states.push({ ...base, status: "failed", error: `duplicate plugin id ${id}` });
            continue;
          }
          seen.add(id);
          const scope = yield* Scope.fork(hostScope);
          const exit = yield* loaded.plugin
            .setup(contextFor({ id, order }, loaded))
            .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, exit);
            const error = describeCause(exit.cause);
            yield* Effect.logError(`plugin ${id} failed to set up: ${error}`);
            states.push({ ...base, status: "failed", error });
            continue;
          }
          states.push({ ...base, status: "active" });
        }
        yield* Ref.set(booting, false);
        yield* rebuild;

        const runtimeRef: PluginRef = { id: "runtime", order: options.plugins.length };

        const agentRegistry = AgentRegistry.of({
          register: Effect.fn("AgentRegistry.register")(function* (agent: AgentDefinition) {
            if ((yield* Ref.get(agents)).has(agent.name)) {
              return yield* new AgentAlreadyRegistered({ name: agent.name });
            }
            yield* transforms
              .register(runtimeRef, (draft) => Effect.sync(() => draft.set(agent)))
              .pipe(Effect.provideService(Scope.Scope, hostScope));
          }),
          get: Effect.fn("AgentRegistry.get")(function* (name: string) {
            const agent = (yield* Ref.get(agents)).get(name);
            if (agent === undefined) {
              return yield* new AgentNotFound({ name });
            }
            return agent;
          }),
          list: Effect.map(Ref.get(agents), (all) => [...all.values()]),
        });

        const plugins = Effect.gen(function* () {
          const toolEntries = yield* tools.entries;
          const providerEntries = yield* providers.entries;
          const owner = yield* Ref.get(owners);
          return states.map(
            (state) =>
              new PluginInfo({
                ...state,
                tools: toolEntries
                  .filter((entry) => entry.plugin.id === state.id)
                  .map((entry) => entry.value.tool.name),
                providers: providerEntries
                  .filter((entry) => entry.plugin.id === state.id)
                  .map((entry) => entry.value.id),
                agents: [...owner].flatMap(([name, by]) => (by === state.id ? [name] : [])),
              }),
          );
        });

        const models = yield* modelRegistryOver(providers.values, hostScope);

        return Context.make(PluginHost, PluginHost.of({ plugins })).pipe(
          Context.add(
            ToolRegistry,
            toolRegistryOver({
              entries: tools.values,
              hooks: toolHooks.values,
              disabled: new Set(options.disabledTools ?? []),
              guard,
            }),
          ),
          Context.add(ModelRegistry, models),
          Context.add(AgentRegistry, agentRegistry),
          Context.add(RunEventBus, bus),
        );
      }),
    );
}
