import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export class RemoteError extends Schema.TaggedError<RemoteError>()("RemoteError", {
  message: Schema.String,
}) {}

export const RemoteDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Finite,
});
export const PairingOffer = Schema.Struct({ url: Schema.String, expiresAt: Schema.Finite });
export type PairingOffer = typeof PairingOffer.Type;
export const RemoteStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  url: Schema.String,
  devices: Schema.Array(RemoteDevice),
  /** The pairing link still open for scanning, if one has not expired yet. */
  pairing: Schema.NullOr(PairingOffer),
});
export type RemoteStatus = typeof RemoteStatus.Type;

/** Local administration only. The relay never forwards this endpoint. */
export const RemoteApi = RpcGroup.make(
  Rpc.make("stopGateway"),
  Rpc.make("remoteStatus", { success: RemoteStatus }),
  Rpc.make("pairRemote", { success: PairingOffer, error: RemoteError }),
  Rpc.make("setRemoteEnabled", {
    payload: { enabled: Schema.Boolean },
    error: RemoteError,
  }),
  Rpc.make("revokeRemoteDevice", {
    payload: { id: Schema.String },
    error: RemoteError,
  }),
);
export const REMOTE_CONTROL_PATH = "/remote/control";
