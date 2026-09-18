/**
 * Gateway credentials.
 *
 * A relay knows exactly one kind of caller by name: the gateway that dials
 * into it. Devices are the gateway's business, not the relay's, so nothing
 * here has a notion of a user, a principal, or a scope. A credential says
 * "this connection may be the control link for gateway X" and nothing else.
 *
 * The token carries the gateway id in the clear so a relay can route on it
 * before it has read any state, and a secret that is only ever stored as a
 * SHA-256 hash. Minting shows the token once.
 */

export interface Credential {
  /** First 12 hex characters of the hash: what an operator revokes by. */
  readonly fingerprint: string;
  readonly hash: string;
  readonly label: string;
  readonly createdAt: number;
}

const PREFIX = "mrk_";

/** Lowercase, DNS-safe, so it can also be a subdomain on the relay's zone. */
const GATEWAY_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isGatewayId = (value: string): boolean => GATEWAY_ID.test(value);

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Length is not a secret; the contents are. Compare in constant time anyway. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface MintedCredential {
  /** Shown once, at mint time. The relay keeps only the hash. */
  readonly token: string;
  readonly credential: Credential;
}

export const mint = async (
  gatewayId: string,
  label: string,
  now: number,
): Promise<MintedCredential> => {
  if (!isGatewayId(gatewayId)) throw new Error(`not a gateway id: ${gatewayId}`);
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const token = `${PREFIX}${gatewayId}.${secret}`;
  const hash = await sha256Hex(token);
  return {
    token,
    credential: { fingerprint: hash.slice(0, 12), hash, label, createdAt: now },
  };
};

/** The gateway id a token claims, before anything has been verified. */
export const gatewayOf = (token: string): string | null => {
  if (!token.startsWith(PREFIX)) return null;
  const dot = token.indexOf(".", PREFIX.length);
  if (dot < 0) return null;
  const id = token.slice(PREFIX.length, dot);
  return isGatewayId(id) && token.length > dot + 1 ? id : null;
};

/** The credential this token is, or null. Every candidate is compared. */
export const verify = async (
  token: string,
  credentials: ReadonlyArray<Credential>,
): Promise<Credential | null> => {
  const hash = await sha256Hex(token);
  let found: Credential | null = null;
  for (const credential of credentials) {
    if (timingSafeEqual(credential.hash, hash)) found = credential;
  }
  return found;
};

/** `Authorization: Bearer <token>`, or the `token` query parameter. */
export const bearerFrom = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null) return match[1] ?? null;
  }
  const query = new URL(request.url).searchParams.get("token");
  return query === null || query === "" ? null : query;
};
