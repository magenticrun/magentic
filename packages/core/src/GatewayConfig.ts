import { Predicate, Schema } from "effect";

/** A plugin to load: a file path or package name, optionally with options. */
export const PluginSpec = Schema.Union([Schema.String, Schema.Tuple([Schema.String, Schema.Json])]);
export type PluginSpec = typeof PluginSpec.Type;

export const PluginsSection = Schema.Struct({
  /** Built-in plugin ids to skip entirely. */
  disable: Schema.optional(Schema.Array(Schema.String)),
  /** External plugins, loaded in this order after the built-ins. */
  use: Schema.optional(Schema.Array(PluginSpec)),
});

/**
 * `magentic.yaml`, the part of it that exists so far. Everything an operator
 * edits lives in this one file; secrets never do.
 */
export class GatewayConfig extends Schema.Class<GatewayConfig>("magentic/core/GatewayConfig")({
  plugins: Schema.optional(PluginsSection),
  /** `name: false` hides a tool from every agent. Policy still decides each call. */
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  /** MCP servers by name. The `mcp` plugin decodes each entry; the gateway only carries them. */
  mcp: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  /** `watch` rebuilds agents when `agents/` changes. SIGHUP always does. */
  reload: Schema.optional(Schema.Literals(["manual", "watch"])),
}) {
  static readonly empty = new GatewayConfig({});

  get disabledPlugins(): ReadonlyArray<string> {
    return this.plugins?.disable ?? [];
  }

  get externalPlugins(): ReadonlyArray<PluginSpec> {
    return this.plugins?.use ?? [];
  }

  get mcpServers(): Readonly<Record<string, Schema.Json>> {
    return this.mcp ?? {};
  }

  get disabledTools(): ReadonlyArray<string> {
    return Object.entries(this.tools ?? {}).flatMap(([name, enabled]) => (enabled ? [] : [name]));
  }
}

export const specName = (spec: PluginSpec): string => (Predicate.isString(spec) ? spec : spec[0]);
export const specOptions = (spec: PluginSpec): Schema.Json =>
  Predicate.isString(spec) ? {} : spec[1];
