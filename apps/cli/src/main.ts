#!/usr/bin/env bun
import { registerSolidTransform } from "./SolidTransform.ts";

// Solid components need the transform registered before their modules load.
// Static imports are hoisted above this call, so the rest of the CLI is imported
// after it. This is the only dynamic import in the CLI.
registerSolidTransform();
await import("./Cli.ts");
