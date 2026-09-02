import type { Schema } from "effect";
import type { AgentDomain } from "./Agents.ts";
import type { CommandDomain } from "./Commands.ts";
import type { EventDomain } from "./Events.ts";
import type { ModelDomain } from "./Models.ts";
import type { ToolDomain } from "./Tools.ts";

/** Where a plugin may keep or find things. Nothing outside these is promised. */
export interface PluginPaths {
  /** The configuration directory, e.g. `./magentic`. */
  readonly config: string;
  /** The directory file tools operate in. */
  readonly workspace: string;
  /** Per-person state that is not configuration: favourites, caches. `~/.config/magentic` by default. */
  readonly data: string;
}

/** What a plugin's `setup` receives. Each domain owns one kind of contribution. */
export interface PluginContext {
  /** From `plugins.use` in the config; `{}` when none were given. Decode with your own Schema. */
  readonly options: Schema.Json;
  readonly paths: PluginPaths;
  readonly tool: ToolDomain;
  readonly model: ModelDomain;
  readonly agent: AgentDomain;
  readonly command: CommandDomain;
  readonly event: EventDomain;
}
