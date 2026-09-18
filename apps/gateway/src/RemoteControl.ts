import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dataDir, relayConfig } from "@magentic/core";
import { RemoteApi, RemoteError, type RemoteStatus, type PairingOffer } from "@magentic/protocol";
import { connect, type Connector } from "@magentic/relay/connector";
import { page } from "@magentic/web/page";
import { Clock, Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";

const StoredDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Finite,
  hash: Schema.String,
});
const State = Schema.Struct({ enabled: Schema.Boolean, devices: Schema.Array(StoredDevice) });
const Join = Schema.Struct({ token: Schema.String, name: Schema.String });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const secret = () => crypto.getRandomValues(new Uint8Array(32)).toHex();
const failure = (message: string) => new RemoteError({ message });
const cookieName = "magentic_device";

export class RemoteControl extends Context.Service<
  RemoteControl,
  {
    readonly status: Effect.Effect<RemoteStatus>;
    readonly pair: Effect.Effect<PairingOffer, RemoteError>;
    setEnabled(enabled: boolean): Effect.Effect<void, RemoteError>;
    revoke(id: string): Effect.Effect<void, RemoteError>;
  }
>()("magentic/gateway/RemoteControl") {
  static layer = (gatewayPort: number) =>
    Layer.effect(
      RemoteControl,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* relayConfig;
        const dir = yield* dataDir;
        const file = `${dir}/remote-devices.json`;
        let state: typeof State.Type = { enabled: true, devices: [] };
        if (yield* fs.exists(file)) {
          state = yield* fs
            .readFileString(file)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))));
        }
        const lock = yield* Semaphore.make(1);
        const save = Effect.fn("RemoteControl.save")(function* (next: typeof State.Type) {
          yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
          const staging = `${file}.${crypto.randomUUID()}.tmp`;
          yield* fs.writeFileString(staging, JSON.stringify(next), { mode: 0o600 });
          yield* fs.rename(staging, file);
          state = next;
        });
        let connected = false;
        let connector: Connector | undefined;
        /**
         * A pairing link is a five-minute window, not a one-shot token: a QR
         * scanned on a phone often lands in an in-app webview first, and the
         * person then reopens the same link in their real browser. Both have to
         * be able to redeem it, so the offer survives a redemption and only a
         * handful of them (or the clock) closes it.
         */
        let offer: { hash: string; url: string; expiresAt: number; uses: number } | undefined;
        const maxPairings = 4;
        const liveOffer = (now: number) =>
          offer !== undefined && now < offer.expiresAt && offer.uses < maxPairings
            ? offer
            : undefined;
        const requests = new Map<string, Set<AbortController>>();
        const abortDevice = (id: string) => {
          for (const request of requests.get(id) ?? []) request.abort();
          requests.delete(id);
        };
        const publicUrl = Option.map(config, (value) => new URL(value.publicUrl ?? value.url));
        if (Option.isSome(publicUrl)) {
          const url = publicUrl.value;
          if (
            url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
          ) {
            return yield* failure(
              "The remote URL must use HTTPS (HTTP is allowed only on loopback for development).",
            );
          }
          if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
            return yield* failure("The remote URL must be an origin, with no path or credentials.");
          }
          const relay = new URL(Option.getOrThrow(config).url);
          if (
            !["https:", "wss:"].includes(relay.protocol) &&
            !(
              ["http:", "ws:"].includes(relay.protocol) &&
              ["localhost", "127.0.0.1"].includes(relay.hostname)
            )
          ) {
            return yield* failure("The relay connection must use TLS except on loopback.");
          }
        }
        const origin = Option.match(publicUrl, { onNone: () => "", onSome: (url) => url.origin });
        const secure = origin.startsWith("https:") ? "; Secure" : "";
        const cookie = (token: string, age = 34560000) =>
          `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
        const headers = {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        };
        const json = (value: Schema.Json, status = 200, extra: Record<string, string> = {}) =>
          Response.json(value, { status, headers: { ...headers, ...extra } });
        let javascript = "";
        let stylesheet = "";
        if (Option.isSome(config)) {
          const { buildWeb } = yield* Effect.promise(() => import("@magentic/web/build"));
          const built = yield* Effect.promise(buildWeb);
          if (!built.success)
            return yield* failure(`Could not prepare the remote app: ${built.logs.join("\n")}`);
          stylesheet = yield* Effect.promise(() =>
            Bun.file(fileURLToPath(import.meta.resolve("@magentic/web/style"))).text(),
          );
          for (const output of built.outputs) {
            if (output.path.endsWith(".css"))
              stylesheet = yield* Effect.promise(() => output.text());
            else if (output.path.endsWith(".js"))
              javascript = yield* Effect.promise(() => output.text());
          }
        }
        const handle = Effect.fn("RemoteControl.request")(function* (request: Request) {
          if (!state.enabled) return json({ error: "Remote control is off." }, 403);
          const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
          if (request.method === "GET" && path === "/")
            return new Response(page, {
              headers: { ...headers, "content-type": "text/html; charset=utf-8" },
            });
          if (request.method === "GET" && path === "/app.js")
            return new Response(javascript, {
              headers: { ...headers, "content-type": "text/javascript" },
            });
          if (request.method === "GET" && path === "/app.css")
            return new Response(stylesheet, {
              headers: { ...headers, "content-type": "text/css" },
            });
          if (request.method !== "GET" && request.headers.get("origin") !== origin)
            return json({ error: "Origin refused." }, 403);
          if (path === "/pair" && request.method === "POST") {
            if (Number(request.headers.get("content-length") ?? 0) > 4096)
              return json({ error: "Pairing request too large." }, 413);
            const body = yield* Effect.tryPromise(() => request.text());
            if (body.length > 4096) return json({ error: "Pairing request too large." }, 413);
            const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Join))(body);
            return yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const open = liveOffer(now);
                if (open === undefined || hash(input.token) !== open.hash)
                  return json(
                    { error: "This pairing link expired. Run /rc pair again for a new one." },
                    401,
                  );
                const token = secret();
                const device = {
                  id: crypto.randomUUID(),
                  name: input.name.trim().slice(0, 80) || "Browser",
                  createdAt: now,
                  hash: hash(token),
                };
                yield* save({ ...state, devices: [...state.devices, device] });
                open.uses += 1;
                return json({ name: device.name, expiresAt: open.expiresAt }, 200, {
                  "set-cookie": cookie(token),
                });
              }),
            );
          }
          const token = request.headers
            .get("cookie")
            ?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1);
          const device =
            token === undefined
              ? undefined
              : state.devices.find((value) => value.hash === hash(token));
          if (device === undefined || token === undefined)
            return json({ error: "Pair this browser with /rc in your terminal." }, 401);
          if (path === "/session" && request.method === "GET")
            return json({ name: device.name }, 200, { "set-cookie": cookie(token) });
          if (path === "/logout" && request.method === "POST") {
            yield* lock.withPermits(1)(
              Effect.suspend(() =>
                save({
                  ...state,
                  devices: state.devices.filter((value) => value.id !== device.id),
                }),
              ),
            );
            abortDevice(device.id);
            return json({}, 200, { "set-cookie": cookie("", 0) });
          }
          if (path !== "/rpc" || request.method !== "POST")
            return json({ error: "Not found." }, 404);
          const abort = new AbortController();
          const active = requests.get(device.id) ?? new Set<AbortController>();
          active.add(abort);
          requests.set(device.id, active);
          const response = yield* Effect.tryPromise(() =>
            fetch(`http://127.0.0.1:${gatewayPort}/rpc`, {
              method: "POST",
              body: request.body,
              signal: abort.signal,
              headers: { "content-type": "application/json" },
            }),
          ).pipe(Effect.onError(() => Effect.sync(() => active.delete(abort))));
          const reader = response.body?.getReader();
          const body =
            reader === undefined
              ? null
              : new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    try {
                      const chunk = await reader.read();
                      if (chunk.done) {
                        active.delete(abort);
                        controller.close();
                      } else controller.enqueue(chunk.value);
                    } catch (error) {
                      active.delete(abort);
                      controller.error(error);
                    }
                  },
                  async cancel() {
                    active.delete(abort);
                    abort.abort();
                    await reader.cancel();
                  },
                });
          return new Response(body, {
            status: response.status,
            headers: {
              ...headers,
              "content-type": response.headers.get("content-type") ?? "application/ndjson",
              "set-cookie": cookie(token),
            },
          });
        });
        const server = Option.isNone(config)
          ? undefined
          : yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  hostname: "127.0.0.1",
                  port: 0,
                  idleTimeout: 255,
                  maxRequestBodySize: 1024 * 1024,
                  fetch: (request) =>
                    Effect.runPromise(
                      handle(request).pipe(
                        Effect.catchCause(() =>
                          Effect.succeed(json({ error: "Remote request failed." }, 400)),
                        ),
                      ),
                    ),
                }),
              ),
              (listener) => Effect.promise(() => listener.stop(true)),
            );
        const start = () => {
          if (connector !== undefined || server === undefined || Option.isNone(config)) return;
          connector = connect({
            relay: config.value.url,
            token: config.value.token,
            target: `http://127.0.0.1:${server.port}`,
            allowRequest: (path, upgrade) =>
              !upgrade &&
              ["/", "/app.js", "/app.css", "/pair", "/session", "/logout", "/rpc"].includes(
                path.replace(/\/+$/, "") || "/",
              ),
            onOpen: () => {
              connected = true;
            },
            onClose: () => {
              connected = false;
            },
          });
        };
        const stop = () => {
          connector?.close();
          connector = undefined;
          connected = false;
          offer = undefined;
          for (const id of requests.keys()) abortDevice(id);
        };
        if (state.enabled) start();
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        return RemoteControl.of({
          status: Effect.gen(function* () {
            const open = liveOffer(yield* Clock.currentTimeMillis);
            return {
              configured: Option.isSome(config),
              enabled: state.enabled && Option.isSome(config),
              connected,
              url: origin,
              devices: state.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
              pairing: open === undefined ? null : { url: open.url, expiresAt: open.expiresAt },
            };
          }),
          pair: lock.withPermits(1)(
            Effect.gen(function* () {
              if (Option.isNone(config))
                return yield* failure(
                  `Configure ${dir}/relay.json with url and token, then restart magentic. See the README's Remote control section.`,
                );
              if (!state.enabled) return yield* failure("Remote control is off. Use /rc on first.");
              if (!connected)
                return yield* failure(
                  "The relay is not connected yet. Check the relay credential and /rc status.",
                );
              const now = yield* Clock.currentTimeMillis;
              const open = liveOffer(now);
              // A link with time left on it is handed back as it is, so the QR
              // already on screen (or already photographed) keeps working.
              if (open !== undefined && open.expiresAt - now > 60_000)
                return { url: open.url, expiresAt: open.expiresAt };
              const token = secret();
              const expiresAt = now + 5 * 60_000;
              offer = { hash: hash(token), url: `${origin}/#pair=${token}`, expiresAt, uses: 0 };
              return { url: offer.url, expiresAt };
            }),
          ),
          setEnabled: Effect.fn("RemoteControl.setEnabled")(function* (enabled: boolean) {
            if (enabled && Option.isNone(config))
              return yield* failure("Configure the relay with magentic relay-setup first.");
            yield* lock
              .withPermits(1)(
                Effect.gen(function* () {
                  yield* save({ ...state, enabled });
                  if (enabled) start();
                  else stop();
                }),
              )
              .pipe(Effect.mapError(() => failure("Could not save remote-control settings.")));
          }),
          revoke: Effect.fn("RemoteControl.revoke")(function* (id: string) {
            yield* lock
              .withPermits(1)(
                Effect.gen(function* () {
                  yield* save({
                    ...state,
                    devices: state.devices.filter((device) => device.id !== id),
                  });
                  abortDevice(id);
                }),
              )
              .pipe(Effect.mapError(() => failure("Could not revoke the device.")));
          }),
        });
      }),
    );
}

export const RemoteHandlers = RemoteApi.toLayer(
  Effect.gen(function* () {
    const remote = yield* RemoteControl;
    return {
      stopGateway: () =>
        Effect.sync(() => {
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 200).unref();
        }),
      remoteStatus: () => remote.status,
      pairRemote: () => remote.pair,
      setRemoteEnabled: ({ enabled }) => remote.setEnabled(enabled),
      revokeRemoteDevice: ({ id }) => remote.revoke(id),
    };
  }),
);
