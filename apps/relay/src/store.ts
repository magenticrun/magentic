/**
 * Where credentials live.
 *
 * Two implementations exist because the relay runs in two places. On
 * Cloudflare each gateway's Durable Object keeps its own rows, so the store
 * is scoped to one gateway and never needs an index from token to object. In
 * a single Bun process one JSON file holds them all.
 */

import type { Credential } from "./credentials.ts";

export interface CredentialStore {
  readonly list: (gatewayId: string) => Promise<Array<Credential>>;
  readonly add: (gatewayId: string, credential: Credential) => Promise<void>;
  readonly remove: (gatewayId: string, fingerprint: string) => Promise<boolean>;
}

interface FileShape {
  readonly gateways: Record<string, Array<Credential>>;
}

const empty: FileShape = { gateways: {} };

/**
 * A file the operator can read, back up, and hand-edit. Writes are
 * serialised through one promise chain, which is enough for a component
 * whose write rate is "when someone mints a credential".
 */
export const fileStore = (path: string): CredentialStore => {
  let queue: Promise<void> = Promise.resolve();

  const read = async (): Promise<FileShape> => {
    const file = Bun.file(path);
    if (!(await file.exists())) return empty;
    const parsed = (await file.json()) as Partial<FileShape>;
    return { gateways: parsed.gateways ?? {} };
  };

  const write = (mutate: (shape: FileShape) => boolean): Promise<boolean> => {
    const run = queue.then(async () => {
      const shape = await read();
      const changed = mutate(shape);
      if (changed) await Bun.write(path, `${JSON.stringify(shape, null, 2)}\n`);
      return changed;
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    list: async (gatewayId) => (await read()).gateways[gatewayId] ?? [],
    add: async (gatewayId, credential) => {
      await write((shape) => {
        const existing = shape.gateways[gatewayId] ?? [];
        shape.gateways[gatewayId] = [...existing, credential];
        return true;
      });
    },
    remove: (gatewayId, fingerprint) =>
      write((shape) => {
        const existing = shape.gateways[gatewayId] ?? [];
        const kept = existing.filter((credential) => credential.fingerprint !== fingerprint);
        if (kept.length === existing.length) return false;
        shape.gateways[gatewayId] = kept;
        return true;
      }),
  };
};
