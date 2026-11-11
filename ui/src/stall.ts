// What keeps an upload from hanging: a watchdog that fires when no bytes have moved for a while (a
// stalled line neither fails nor finishes), the wait between tries, and a wait for the connection to
// come back. Pure apart from the timers it is given, so it is tested with fake ones.

/** How long an upload may go without a byte moving before it is taken for stalled. */
export const STALL_MS = 30_000;
/** How often a request is sent again before the upload stops (it goes on from where it stood when asked again). */
export const TRIES = 8;

/** The wait before try `n` (1 first): doubling from a second, at most 30 seconds, jittered by a quarter either way so many uploads do not all return at once. */
export function backoff(n: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));
  return Math.round(base * (0.75 + 0.5 * random()));
}

/** Calls `onStall` once if `poke()` is not called for `ms`. `poke` is called whenever bytes move. */
export class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  constructor(
    private readonly onStall: () => void,
    private readonly ms: number = STALL_MS,
  ) {
    this.poke();
  }
  poke() {
    if (this.done) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.done = true;
      this.onStall();
    }, this.ms);
  }
  stop() {
    this.done = true;
    clearTimeout(this.timer);
  }
}

/** Resolves at once when the browser says it is online; otherwise when the `online` event comes (or `signal` aborts). Waiting for a connection does not use up a try. */
export function whenOnline(signal?: AbortSignal, online: () => boolean = () => typeof navigator === "undefined" || navigator.onLine !== false, target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = globalThis): Promise<void> {
  if (online()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      target.removeEventListener?.("online", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    // (A page has the event; anything else is let go by the signal alone.)
    target.addEventListener?.("online", done);
    signal?.addEventListener("abort", done);
  });
}

/** Whether a failed request is the connection's fault (worth trying again): no answer, a stall, too slow, too many, or the server's own trouble. */
export const connectionLost = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
