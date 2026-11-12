import { describe, expect, it, vi } from "vitest";

vi.mock("@ferrum/client", () => ({ shell: () => ({}), errorMessage: (e: unknown) => (e as Error).message }));
const { trackInBar, trayOf } = await import("./barTray");

/** A tray that, like the bar's, ignores anything reported after done or fail. */
function fakeTray() {
  const log: string[] = [];
  let over = false;
  let options: { cancel?: () => void; retry?: () => void } = {};
  const live = (s: string) => () => void (!over && log.push(s));
  const tray = {
    track: async (o: typeof options & { label: string; size: number }) => {
      options = o;
      log.push(`track ${o.label} ${o.size}`);
      return {
        id: "t1",
        progress: (n: number) => void (!over && log.push(`progress ${n}`)),
        retrying: (m?: string) => void (!over && log.push(`retrying ${m}`)),
        sending: live("sending"),
        done: () => void (!over && (log.push("done"), (over = true))),
        fail: (m?: string) => void (!over && (log.push(`fail ${m}`), (over = true))),
      };
    },
  };
  return { tray, log, options: () => options, reopen: () => (over = false) };
}

describe("the bar's tray", () => {
  it("is found only on a shell that can track", () => {
    expect(trayOf({})).toBeNull();
    expect(trayOf({ uploads: { start() {} } })).toBeNull();
    expect(trayOf({ uploads: { track: async () => ({}) } })).not.toBeNull();
    expect(trayOf(undefined)).toBeNull();
  });

  it("gives the caller nothing to wait for when the bar cannot track, or refuses the row", async () => {
    expect(await trackInBar(null, { name: "a", size: 1 }, async () => {})).toBeNull();
    expect(await trackInBar({ track: async () => Promise.reject(new Error("no")) }, { name: "a", size: 1 }, async () => {})).toBeNull();
  });

  it("maps progress, the retry note, and success; later calls are harmless", async () => {
    const f = fakeTray();
    const { ran } = (await trackInBar(f.tray, { name: "big.bin", size: 100 }, async (r) => {
      r.step(40);
      r.note("The connection dropped");
      r.note(null);
      r.step(100);
    }))!;
    await ran;
    expect(f.log).toEqual(["track big.bin 100", "progress 40", "retrying The connection dropped", "sending", "progress 100", "done"]);
  });

  it("reports a failure, rejecting the first try", async () => {
    const f = fakeTray();
    const { ran } = (await trackInBar(f.tray, { name: "a", size: 5 }, async () => Promise.reject(new Error("Too big"))))!;
    await expect(ran).rejects.toThrow("Too big");
    expect(f.log.at(-1)).toBe("fail Too big");
  });

  it("stops the try on the bar's Stop without reporting a failure, and runs again on its Retry", async () => {
    const f = fakeTray();
    let signal!: AbortSignal;
    let n = 0;
    const after = vi.fn();
    const { ran } = (await trackInBar(
      f.tray,
      { name: "a", size: 5 },
      (_r, s) => {
        signal = s;
        return ++n === 1 ? new Promise((_, rej) => s.addEventListener("abort", () => rej(Object.assign(new Error("Stopped."), { aborted: true })))) : Promise.resolve();
      },
      after,
    ))!;
    f.options().cancel!();
    expect(signal.aborted).toBe(true);
    await expect(ran).rejects.toMatchObject({ aborted: true });
    expect(f.log.some((l) => l.startsWith("fail"))).toBe(false);
    f.options().retry!();
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(n).toBe(2);
    expect(f.log.at(-1)).toBe("done");
  });
});
