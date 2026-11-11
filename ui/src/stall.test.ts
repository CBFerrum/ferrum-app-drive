import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALL_MS, Watchdog, backoff, connectionLost, whenOnline } from "./stall";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the stall watchdog", () => {
  it("fires once when no bytes move for the time, and not while they do", () => {
    const stalled = vi.fn();
    const dog = new Watchdog(stalled);
    vi.advanceTimersByTime(STALL_MS - 1);
    dog.poke();
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(stalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(stalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * STALL_MS);
    expect(stalled).toHaveBeenCalledTimes(1);
  });
  it("is quiet once stopped", () => {
    const stalled = vi.fn();
    const dog = new Watchdog(stalled, 1000);
    dog.stop();
    vi.advanceTimersByTime(5000);
    expect(stalled).not.toHaveBeenCalled();
  });
});

describe("the wait between tries", () => {
  it("doubles from a second to at most half a minute, jittered by a quarter", () => {
    const at = (n: number, r: number) => backoff(n, () => r);
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => at(n, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect([at(1, 0), at(1, 1), at(6, 0), at(6, 1)]).toEqual([750, 1250, 22500, 37500]);
  });
  it("tells the connection's fault from a refusal", () => {
    expect([0, 408, 429, 500, 503].every(connectionLost)).toBe(true);
    expect([400, 401, 403, 404, 409, 422].some(connectionLost)).toBe(false);
  });
});

describe("waiting for the connection", () => {
  it("goes on at once online, and waits for the online event offline", async () => {
    await expect(whenOnline(undefined, () => true)).resolves.toBeUndefined();
    const target = new EventTarget();
    let resumed = false;
    const waiting = whenOnline(undefined, () => false, target).then(() => (resumed = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resumed).toBe(false);
    target.dispatchEvent(new Event("online"));
    await waiting;
    expect(resumed).toBe(true);
  });
  it("lets go when the upload is stopped meanwhile", async () => {
    const stop = new AbortController();
    const waiting = whenOnline(stop.signal, () => false, new EventTarget());
    stop.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
