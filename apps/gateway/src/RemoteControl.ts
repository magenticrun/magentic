import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import { dataDir, relayConfig } from "@magentic/core";
import { RemoteApi, RemoteError, type RemoteStatus, type PairingOffer } from "@magentic/protocol";
import { connect, type Connector } from "@magentic/relay/connector";
import { page } from "@magentic/web/page";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { NetAddress } from "effect/unstable/net";

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
const maxPairingBody = 4096;
const securityHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
/** What `Response.json` answered with before, kept so clients see the same header. */
const jsonType = "application/json;charset=utf-8";
const reply = (body: Schema.Json, status = 200) =>
  HttpServerResponse.json(body, { status, contentType: jsonType });

/**
 * The path as the router should see it: the URL's own pathname with trailing
 * slashes dropped. The router decodes `%xx` escapes and cuts at `;` before it
 * matches, which would let `/%61pp.js` or `/app.js;x` reach a route by a name
 * the route was never given; escaping both keeps the match literal.
 */
const routable = (url: string) =>
  Effect.try({
    try: () => new URL(url).pathname.replace(/\/+$/, "") || "/",
    catch: () => failure("Unreadable request URL."),
  }).pipe(Effect.map((path) => path.replaceAll("%", "%25").replaceAll(";", "%3B")));

/**
 * A pairing link is a five-minute window, not a one-shot token: a QR
 * scanned on a phone often lands in an in-app webview first, and the
 * person then reopens the same link in their real browser. Both have to
 * be able to redeem it, so the offer survives a redemption and only a
 * handful of them (or the clock) closes it.
 */
interface Offer {
  readonly hash: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly uses: number;
}
const maxPairings = 4;

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
        const client = yield* HttpClient.HttpClient;
        const config = yield* relayConfig;
        const dir = yield* dataDir;
        const file = `${dir}/remote-devices.json`;
        const state = yield* Ref.make<typeof State.Type>(
          (yield* fs.exists(file))
            ? yield* fs
                .readFileString(file)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))))
            : { enabled: true, devices: [] },
        );
        const lock = yield* Semaphore.make(1);
        const save = Effect.fn("RemoteControl.save")(function* (next: typeof State.Type) {
          yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
          const staging = `${file}.${crypto.randomUUID()}.tmp`;
          yield* fs.writeFileString(staging, JSON.stringify(next), { mode: 0o600 });
          yield* fs.rename(staging, file);
          yield* Ref.set(state, next);
        });
        // The relay connector reports its socket through plain callbacks.
        let connected = false;
        let connector: Connector | undefined;
        const offer = yield* Ref.make(Option.none<Offer>());
        const liveOffer = (now: number) =>
          Effect.map(
            Ref.get(offer),
            Option.filter((open) => now < open.expiresAt && open.uses < maxPairings),
          );
        /**
         * One signal per device with a proxied `/rpc` in flight. Failing it
         * cuts every response that device is streaming, and the upstream
         * request with it, which is what logging out or revoking has to do.
         */
        const streams = yield* Ref.make(
          HashMap.empty<string, Deferred.Deferred<never, RemoteError>>(),
        );
        const enlist = Effect.fnUntraced(function* (id: string) {
          const fresh = yield* Deferred.make<never, RemoteError>();
          return yield* Ref.modify(streams, (all) =>
            Option.match(HashMap.get(all, id), {
              onSome: (existing) => [existing, all] as const,
              onNone: () => [fresh, HashMap.set(all, id, fresh)] as const,
            }),
          );
        });
        const cut = (signals: Iterable<Deferred.Deferred<never, RemoteError>>) =>
          Effect.forEach(signals, (signal) => Deferred.fail(signal, failure("Signed out.")), {
            discard: true,
          });
        const cutDevice = (id: string) =>
          Ref.modify(
            streams,
            (all) => [HashMap.get(all, id), HashMap.remove(all, id)] as const,
          ).pipe(Effect.flatMap((signal) => cut(Option.toArray(signal))));
        const cutAll = Ref.getAndSet(streams, HashMap.empty()).pipe(
          Effect.flatMap((all) => cut(HashMap.values(all))),
        );
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
        const withCookie = (token: string, maxAge = Duration.seconds(34_560_000)) =>
          HttpServerResponse.setCookie(cookieName, token, {
            path: "/",
            httpOnly: true,
            sameSite: "strict",
            maxAge,
            secure: origin.startsWith("https:"),
          });

        const pairDevice = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (Number(request.headers["content-length"] ?? 0) > maxPairingBody)
            return yield* reply({ error: "Pairing request too large." }, 413);
          const body = yield* request.text;
          if (body.length > maxPairingBody)
            return yield* reply({ error: "Pairing request too large." }, 413);
          const input = yield* Schema.decodeEffect(Schema.fromJsonString(Join))(body);
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const open = yield* liveOffer(now);
              if (Option.isNone(open) || hash(input.token) !== open.value.hash)
                return yield* reply(
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
              const current = yield* Ref.get(state);
              yield* save({ ...current, devices: [...current.devices, device] });
              yield* Ref.update(
                offer,
                Option.map((value) =>
                  value.hash === open.value.hash ? { ...value, uses: value.uses + 1 } : value,
                ),
              );
              return yield* reply({ name: device.name, expiresAt: open.value.expiresAt }).pipe(
                Effect.flatMap(withCookie(token)),
              );
            }),
          );
        });

        /** Runs `handle` for a paired browser; anything else is told to pair first. */
        const paired = <E>(
          handle: (
            device: typeof StoredDevice.Type,
            token: string,
          ) => Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            E,
            HttpServerRequest.HttpServerRequest
          >,
        ) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const token = request.cookies[cookieName];
            const { devices } = yield* Ref.get(state);
            const device =
              token === undefined ? undefined : devices.find((value) => value.hash === hash(token));
            if (device === undefined || token === undefined)
              return yield* reply({ error: "Pair this browser with /rc in your terminal." }, 401);
            return yield* handle(device, token);
          });

        const logout = Effect.fn("RemoteControl.logout")(function* (
          device: typeof StoredDevice.Type,
        ) {
          yield* lock.withPermits(1)(
            Ref.get(state).pipe(
              Effect.flatMap((current) =>
                save({
                  ...current,
                  devices: current.devices.filter((value) => value.id !== device.id),
                }),
              ),
            ),
          );
          yield* cutDevice(device.id);
          return yield* reply({}).pipe(Effect.flatMap(withCookie("", Duration.zero)));
        });

        const proxy = Effect.fn("RemoteControl.proxy")(function* (
          device: typeof StoredDevice.Type,
          token: string,
        ) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const signal = yield* enlist(device.id);
          // Enlisting first and checking again after closes the gap where a
          // logout lands between the cookie check and the enlisting.
          const current = yield* Ref.get(state);
          if (!current.enabled || !current.devices.some((value) => value.id === device.id))
            return yield* failure("Signed out.");
          const cutOff = Deferred.await(signal);
          const upstream = yield* client
            .execute(
              HttpClientRequest.post(`http://127.0.0.1:${gatewayPort}/rpc`).pipe(
                HttpClientRequest.bodyStream(request.stream, { contentType: "application/json" }),
              ),
            )
            .pipe(
              Effect.provideService(HttpClient.TracerPropagationEnabled, false),
              Effect.raceFirst(cutOff),
            );
          return yield* withCookie(token)(
            HttpServerResponse.stream(upstream.stream.pipe(Stream.interruptWhen(cutOff)), {
              status: upstream.status,
              contentType: upstream.headers["content-type"] ?? "application/ndjson",
            }),
          );
        });

        /**
         * Builds the app, serves it on a loopback port of its own, and
         * answers with the address the relay connector forwards to.
         */
        const serve = Effect.gen(function* () {
          const { buildWeb } = yield* Effect.promise(() => import("@magentic/web/build"));
          const built = yield* Effect.promise(buildWeb);
          if (!built.success)
            return yield* failure(`Could not prepare the remote app: ${built.logs.join("\n")}`);
          const style = yield* Effect.promise(() =>
            Bun.file(fileURLToPath(import.meta.resolve("@magentic/web/style"))).text(),
          );
          const css = built.outputs.findLast((output) => output.path.endsWith(".css"));
          const js = built.outputs.findLast((output) => output.path.endsWith(".js"));
          const stylesheet = css === undefined ? style : yield* Effect.promise(() => css.text());
          const javascript = js === undefined ? "" : yield* Effect.promise(() => js.text());
          const router = yield* HttpRouter.toHttpEffect(
            Layer.mergeAll(
              HttpRouter.add(
                "GET",
                "/",
                HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8" }),
              ),
              HttpRouter.add(
                "GET",
                "/app.js",
                HttpServerResponse.text(javascript, { contentType: "text/javascript" }),
              ),
              HttpRouter.add(
                "GET",
                "/app.css",
                HttpServerResponse.text(stylesheet, { contentType: "text/css" }),
              ),
              HttpRouter.add("POST", "/pair", pairDevice),
              HttpRouter.add(
                "GET",
                "/session",
                paired((device, token) =>
                  reply({ name: device.name }).pipe(Effect.flatMap(withCookie(token))),
                ),
              ),
              HttpRouter.add(
                "POST",
                "/logout",
                paired((device) => logout(device)),
              ),
              HttpRouter.add("POST", "/rpc", paired(proxy)),
              // Unknown paths still ask for pairing first, so a stranger
              // learns nothing about which ones exist.
              HttpRouter.add(
                "*",
                "*",
                paired(() => reply({ error: "Not found." }, 404)),
              ),
            ),
          ).pipe(
            // `routable` has already normalised the path; match it as given.
            Effect.provideService(HttpRouter.RouterConfig, {
              caseSensitive: true,
              ignoreTrailingSlash: false,
              ignoreDuplicateSlashes: false,
            }),
            // This layer is built inside the gateway's own layer graph, and
            // `HttpRouter.layer` is memoised there: without a memo map of its
            // own, these routes would land on the gateway's public router.
            Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
          );
          const server = yield* BunHttpServer.make({
            hostname: "127.0.0.1",
            port: 0,
            // Bun's most: a streamed run can sit quiet for a while.
            idleTimeout: 255,
            maxRequestBodySize: 1024 * 1024,
          });
          yield* server.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (!(yield* Ref.get(state)).enabled)
                return yield* reply({ error: "Remote control is off." }, 403);
              const path = yield* routable(request.originalUrl);
              // Every route a GET reaches is public, so only the others need
              // to come from the page this server handed out.
              if (request.method !== "GET" && request.headers.origin !== origin)
                return yield* reply({ error: "Origin refused." }, 403);
              return yield* router.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  request.modify({ url: path }),
                ),
              );
            }).pipe(
              Effect.catchCause(() => reply({ error: "Remote request failed." }, 400)),
              Effect.map(HttpServerResponse.setHeaders(securityHeaders)),
            ),
          );
          return yield* Effect.fromResult(NetAddress.formatUrl(server.address));
        });
        const target = Option.isNone(config) ? Option.none<string>() : Option.some(yield* serve);

        const start = Effect.sync(() => {
          if (connector !== undefined || Option.isNone(target) || Option.isNone(config)) return;
          connector = connect({
            relay: config.value.url,
            token: config.value.token,
            target: target.value,
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
        });
        const stop = Effect.gen(function* () {
          connector?.close();
          connector = undefined;
          connected = false;
          yield* Ref.set(offer, Option.none());
          yield* cutAll;
        });
        if ((yield* Ref.get(state)).enabled) yield* start;
        yield* Effect.addFinalizer(() => stop);
        return RemoteControl.of({
          status: Effect.gen(function* () {
            const open = yield* liveOffer(yield* Clock.currentTimeMillis);
            const current = yield* Ref.get(state);
            return {
              configured: Option.isSome(config),
              enabled: current.enabled && Option.isSome(config),
              connected,
              url: origin,
              devices: current.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
              pairing: Option.match(open, {
                onNone: () => null,
                onSome: ({ url, expiresAt }) => ({ url, expiresAt }),
              }),
            };
          }),
          pair: lock.withPermits(1)(
            Effect.gen(function* () {
              if (Option.isNone(config))
                return yield* failure(
                  `Configure ${dir}/relay.json with url and token, then restart magentic. See the README's Remote control section.`,
                );
              if (!(yield* Ref.get(state)).enabled)
                return yield* failure("Remote control is off. Use /rc on first.");
              if (!connected)
                return yield* failure(
                  "The relay is not connected yet. Check the relay credential and /rc status.",
                );
              const now = yield* Clock.currentTimeMillis;
              const open = yield* liveOffer(now);
              // A link with time left on it is handed back as it is, so the QR
              // already on screen (or already photographed) keeps working.
              if (Option.isSome(open) && open.value.expiresAt - now > 60_000)
                return { url: open.value.url, expiresAt: open.value.expiresAt };
              const token = secret();
              const expiresAt = now + 5 * 60_000;
              const url = `${origin}/#pair=${token}`;
              yield* Ref.set(offer, Option.some({ hash: hash(token), url, expiresAt, uses: 0 }));
              return { url, expiresAt };
            }),
          ),
          setEnabled: Effect.fn("RemoteControl.setEnabled")(function* (enabled: boolean) {
            if (enabled && Option.isNone(config))
              return yield* failure("Configure the relay with magentic relay-setup first.");
            yield* lock
              .withPermits(1)(
                Effect.gen(function* () {
                  yield* save({ ...(yield* Ref.get(state)), enabled });
                  yield* enabled ? start : stop;
                }),
              )
              .pipe(Effect.mapError(() => failure("Could not save remote-control settings.")));
          }),
          revoke: Effect.fn("RemoteControl.revoke")(function* (id: string) {
            yield* lock
              .withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* Ref.get(state);
                  yield* save({
                    ...current,
                    devices: current.devices.filter((device) => device.id !== id),
                  });
                  yield* cutDevice(id);
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
    // The stop is forked into the handlers' scope so the RPC answers first,
    // and a gateway already shutting down interrupts it instead of waiting.
    const scope = yield* Effect.scope;
    return {
      stopGateway: () =>
        Effect.sleep(Duration.seconds(1)).pipe(
          Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
      remoteStatus: () => remote.status,
      pairRemote: () => remote.pair,
      setRemoteEnabled: ({ enabled }) => remote.setEnabled(enabled),
      revokeRemoteDevice: ({ id }) => remote.revoke(id),
    };
  }),
);
