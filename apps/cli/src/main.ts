#!/usr/bin/env bun
import { registerSolidTransform } from "./SolidTransform.ts";

// Solid components need the transform registered before their modules load.
// Static imports are hoisted above this call, so the rest of the CLI is imported
// after it. The other dynamic imports in the CLI load a command's own modules.
registerSolidTransform();
await import("./Cli.ts");
