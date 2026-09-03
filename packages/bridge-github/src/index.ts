export * from "./Bridge.ts";
export * from "./Config.ts";
export * from "./Events.ts";
export * from "./Git.ts";
export * from "./GitHubApi.ts";
export * from "./Plugin.ts";
export * from "./Polling.ts";
export * from "./State.ts";
export * from "./Tools.ts";
export * from "./Webhook.ts";

import { githubBridgePlugin } from "./Plugin.ts";

/** What `plugins.use` loads: the plugin itself. */
export default githubBridgePlugin;
