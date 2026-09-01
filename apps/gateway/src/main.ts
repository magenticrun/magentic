import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpServerLayer } from "./Server.ts";

Layer.launch(HttpServerLayer).pipe(BunRuntime.runMain);
