import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let standing = 0;
let deleteWith = 0;
vi.mock("@ferrum/client", () => ({
  ApiError: class extends Error {
    constructor(readonly status: number) {
      super("x");
    }
  },
  t: (s: string, v?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v?.[k] ?? "")),
  api: {
    del: async (url: string) => {
      calls.push(`DELETE ${url}`);
      if (deleteWith) throw new (class extends Error {
        status = deleteWith;
      })();
    },
    get: async () => ({ upload_id: "u1", size: 20, offset: standing, part_bytes: 8, expires_at: new Date(Date.now() + 1e7).toISOString(), parts: true }),
    post: async (url: string) => (calls.push(`POST ${url}`), url.endsWith("/complete") ? { id: "file" } : { upload_id: "u1", size: 20, offset: 0, part_bytes: 8, expires_at: new Date(Date.now() + 1e7).toISOString(), parts: true }),
  },
}));
const { Refused, uploadResumable } = await import("./partsUpload");

const file = { name: "big.bin", size: 20, lastModified: 1, type: "", slice: (a: number, b: number) => ({ size: Math.min(b, 20) - a }) as unknown as Blob } as unknown as File;
const report = { step: vi.fn(), note: vi.fn() };
const noWait = () => Promise.resolve();

beforeEach(() => {
  calls.length = 0;
  standing = 0;
  deleteWith = 0;
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

describe("a large upload in parts", () => {
  it("sends each part from where the last one ended and completes", async () => {
    const urls: string[] = [];
    const send = async (_m: string, url: string, body: Blob) => (urls.push(url), { offset: Math.min(20, Number(url.split("/").pop()) + (body as { size: number }).size) });
    await uploadResumable(file, report, new AbortController().signal, send as never, noWait);
    expect(urls.map((u) => u.split("/").pop())).toEqual(["0", "8", "16"]);
    expect(calls.at(-1)).toContain("/complete");
  });

  it("sends a stalled part again after a wait, from where the server says it stands, and goes on", async () => {
    let n = 0;
    const waits: number[] = [];
    const send = async (_m: string, url: string, body: Blob) => {
      const at = Number(url.split("/").pop());
      if (at === 8 && n++ < 2) throw new Refused("stalled", 0, true);
      return { offset: Math.min(20, at + (body as { size: number }).size) };
    };
    standing = 8;
    await uploadResumable(file, report, new AbortController().signal, send as never, async (ms) => void waits.push(ms));
    expect(n).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(waits[0] * 0.9);
    expect(calls.at(-1)).toContain("/complete");
  });

  it("stops with the stalled words after the tries are spent, keeping what was sent for asking again", async () => {
    const send = async () => {
      throw new Refused("stalled", 0, true);
    };
    await expect(uploadResumable(file, report, new AbortController().signal, send as never, noWait)).rejects.toMatchObject({ stalled: true, message: "The connection stopped responding." });
    expect(localStorage.getItem("drive.parts")).toContain("u1");
    expect(calls.some((c) => c.includes("/complete"))).toBe(false);
  });

  it("waits for the connection when offline, and does not use up a try", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const stop = new AbortController();
    let sends = 0;
    const send = async (_m: string, url: string, body: Blob) => {
      sends++;
      if (sends === 1) {
        vi.stubGlobal("navigator", { onLine: false });
        setTimeout(() => stop.abort(), 0);
        throw new Refused("dropped", 0);
      }
      return { offset: Math.min(20, Number(url.split("/").pop()) + (body as { size: number }).size) };
    };
    await uploadResumable(file, report, stop.signal, send as never, noWait).catch(() => {});
    expect(report.note).toHaveBeenCalledWith("Waiting for the connection to come back");
  });

  it("does not try a refusal again", async () => {
    const send = async () => {
      throw new Refused("too big", 422);
    };
    await expect(uploadResumable(file, report, new AbortController().signal, send as never, noWait)).rejects.toMatchObject({ status: 422 });
  });
});

describe("Stop on a large upload", () => {
  const stopAfterFirstPart = async (reportOver = report) => {
    const stop = new AbortController();
    const send = async (_m: string, url: string) => {
      stop.abort();
      throw Object.assign(new Error("Stopped."), { aborted: true, url });
    };
    await expect(uploadResumable(file, reportOver, stop.signal, send as never, noWait)).rejects.toMatchObject({ aborted: true });
  };

  it("asks the server to discard the parts and forgets the upload", async () => {
    const discarded = vi.fn();
    await stopAfterFirstPart({ ...report, discarded } as never);
    expect(calls).toContain("DELETE /api/files/uploads/u1");
    expect(discarded).toHaveBeenCalledOnce();
    expect(localStorage.getItem("drive.parts")).toBeNull();
  });

  it("keeps the upload id, and does not say discarded, when the server has no such route", async () => {
    deleteWith = 404;
    const discarded = vi.fn();
    await stopAfterFirstPart({ ...report, discarded } as never);
    expect(discarded).not.toHaveBeenCalled();
    expect(localStorage.getItem("drive.parts")).toContain("u1");
  });
});
