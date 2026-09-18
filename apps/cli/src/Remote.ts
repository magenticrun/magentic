import { CommandError } from "@magentic/plugin";
import { RemoteApi, REMOTE_CONTROL_PATH } from "@magentic/protocol";
import { Clock, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { QRCode } from "@opentui/qrcode";

export const remoteClient = (baseUrl: string) =>
  RpcClient.make(RemoteApi).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `${baseUrl}${REMOTE_CONTROL_PATH}` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(
          Layer.effect(HttpClient.HttpClient)(
            Effect.map(HttpClient.HttpClient, HttpClient.filterStatusOk),
          ),
        ),
      ),
    ),
  );

export const remoteCommand = Effect.fn("Cli.remoteControl")(
  function* (
    client: Effect.Success<ReturnType<typeof remoteClient>>,
    args: string,
    conversation: Effect.Effect<Option.Option<string>>,
    showQr?: (code: string) => Effect.Effect<void>,
  ) {
    const [action = "", id] = args.trim().split(/\s+/);
    if (action === "off" || action === "on") {
      yield* client.setRemoteEnabled({ enabled: action === "on" });
      return action === "on"
        ? "Remote control enabled. The gateway reconnects in the background."
        : "Remote control off. Paired devices are remembered but cannot connect.";
    }
    if (action === "revoke" && id !== undefined) {
      yield* client.revokeRemoteDevice({ id });
      return "Device revoked.";
    }
    if (!["", "status", "devices", "pair"].includes(action)) {
      return "Usage: /rc [status | pair | devices | revoke <id> | on | off]";
    }
    const status = yield* client.remoteStatus();
    if (action === "status" || action === "devices") {
      return [
        !status.configured
          ? "No relay configured. Run /rc for setup instructions."
          : !status.enabled
            ? "Remote control off."
            : status.connected
              ? `Connected · ${status.url}`
              : "Relay disconnected; reconnecting in the background (check the credential if this persists).",
        ...status.devices.map((device) => `${device.id}  ${device.name}`),
        "The gateway stays reachable after the CLI exits while this computer is awake.",
      ].join("\n");
    }
    const current = yield* conversation;
    const suffix = Option.match(current, {
      onNone: () => "",
      onSome: (conversationId) => `conversation=${encodeURIComponent(conversationId)}`,
    });
    if (
      action !== "pair" &&
      status.pairing === null &&
      status.devices.length > 0 &&
      status.enabled &&
      status.configured
    ) {
      return `${status.url}/#${suffix}\n${status.connected ? "Connected" : "Relay disconnected"} · ${status.devices.length} paired device(s). Use /rc pair to add a browser.`;
    }
    // A link with time left on it comes back unchanged, so running /rc again
    // after a scan that went astray reprints the QR that is still good.
    const offer = yield* client.pairRemote();
    const url = `${offer.url}${suffix === "" ? "" : `&${suffix}`}`;
    if (showQr !== undefined) yield* showQr(url);
    const terminalQr =
      showQr === undefined ? `${QRCode.encodeText(url).toTerminalString({ ansi: true })}\n` : "";
    const left = offer.expiresAt - (yield* Clock.currentTimeMillis);
    const minutes = Math.round(left / 60_000);
    const remaining =
      left < 60_000 ? "under a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
    return `${terminalQr}${url}\nScan to pair this browser. The link lasts ${remaining} and works for every browser you open it in, so if your phone opens it in an in-app view you can still reopen it in Safari.\n/rc devices lists paired browsers; /rc revoke <id> removes one.`;
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((error) => {
        const missingEndpoint =
          error._tag === "RpcClientError" &&
          error.reason._tag === "HttpError" &&
          error.reason.cause instanceof HttpClientError.StatusCodeError &&
          error.reason.cause.response.status === 404;
        return new CommandError({
          command: "rc",
          message: missingEndpoint
            ? "The running gateway predates remote control. Quit the older magentic session that started it, then reopen magentic and run /rc again."
            : error._tag === "RemoteError"
              ? error.message
              : `Remote control could not reach the gateway: ${String(error)}`,
        });
      }),
    ),
);
