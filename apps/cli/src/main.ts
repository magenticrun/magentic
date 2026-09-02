#!/usr/bin/env bun
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";

// Solid components need the Babel transform registered before their modules load.
// Static imports are hoisted above this call, so the rest of the CLI is imported
// after it. This is the only dynamic import in the CLI.
ensureSolidTransformPlugin();
await import("./Cli.ts");
