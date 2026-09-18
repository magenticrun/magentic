/**
 * A send window.
 *
 * Both ends of the tunnel read from a stream and write into a socket, and
 * neither can see how fast the other is draining. So a writer may only put a
 * window's worth of bytes in flight; the reader grants more as its own
 * consumer takes them. Without this a device downloading slowly would leave
 * the whole of a large response sitting in the relay, which on Cloudflare is
 * a Durable Object with 128 MB to its name.
 *
 * A pause message would not do: between saying stop and being heard lies a
 * round trip, and a fast writer fills that round trip with as much as it
 * likes. A window is the bound.
 */

export class Credit {
  #available: number;
  #closed = false;
  #waiting: Array<() => void> = [];

  constructor(initial: number) {
    this.#available = initial;
  }

  /** Null when there is room to write, which is the common case. */
  wait(): Promise<void> | null {
    if (this.#closed || this.#available > 0) return null;
    return new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  spend(bytes: number): void {
    this.#available -= bytes;
  }

  grant(bytes: number): void {
    this.#available += bytes;
    this.#wake();
  }

  /** The stream is over. Let every waiter go so its pump can finish. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    if (this.#waiting.length === 0) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resolve of waiting) resolve();
  }
}

/**
 * The reader's half: how much has arrived since the writer was last given
 * room. Granting at half a window keeps a fast stream from stopping and a
 * slow one from costing a control frame per chunk.
 */
export const shouldGrant = (received: number, window: number): boolean => received >= window / 2;
