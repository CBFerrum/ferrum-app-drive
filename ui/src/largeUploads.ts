// The uploads Drive carries itself (a large file in parts, a new version): the shell's tray takes only
// single requests it sends, so these have their own small list, with real progress, Stop and Retry (Drive's
// panel, UploadsPanel.tsx). A tiny store so the page can know there is something to show.

import { useSyncExternalStore } from "react";
import { errorMessage } from "@ferrum/client";
import { trackInBar, trayOf } from "./barTray";
import type { Report } from "./partsUpload";

export interface Row {
  id: number;
  name: string;
  size: number;
  sent: number;
  state: "going" | "failed" | "done" | "stopped";
  /** What is happening when it is not simply sending (retrying, waiting for the connection). */
  note: string | null;
  error: string | null;
  /** Stopped, and the server discarded what was sent (otherwise it is kept for a day). */
  discarded?: boolean;
}

type Run = (report: Report, signal: AbortSignal) => Promise<unknown>;

let rows: Row[] = [];
const subs = new Set<() => void>();
const runs = new Map<number, { run: Run; stop: AbortController; after?: () => void }>();
let seq = 0;
const set = (next: Row[]) => {
  rows = next;
  subs.forEach((s) => s());
};
const patch = (id: number, change: Partial<Row>) => set(rows.map((r) => (r.id === id ? { ...r, ...change } : r)));

export const useRows = () =>
  useSyncExternalStore(
    (s) => (subs.add(s), () => void subs.delete(s)),
    () => rows,
    () => rows,
  );

async function go(id: number) {
  const entry = runs.get(id);
  if (!entry) return;
  entry.stop = new AbortController();
  patch(id, { state: "going", error: null, note: null, discarded: false });
  await entry.run({ step: (sent) => patch(id, { sent }), note: (note) => patch(id, { note }), discarded: () => patch(id, { discarded: true }) }, entry.stop.signal);
  patch(id, { state: "done", sent: rows.find((r) => r.id === id)?.size ?? 0, note: null });
  setTimeout(() => dismiss(id), 6000);
}

/** Starts a tracked upload: in the bar's tray when the bar can track it, else in Drive's panel. The promise settles with the first try: stopped or failed rejects (a Retry goes on by itself, then calls `after`). */
export async function track(file: { name: string; size: number }, run: Run, after?: () => void): Promise<unknown> {
  const bar = await trackInBar(trayOf(), file, run, after);
  return bar ? bar.ran : trackInPanel(file, run, after);
}

function trackInPanel(file: { name: string; size: number }, run: Run, after?: () => void): Promise<unknown> {
  const id = ++seq;
  runs.set(id, { run, stop: new AbortController(), after });
  set([...rows, { id, name: file.name, size: file.size, sent: 0, state: "going", note: null, error: null }]);
  return go(id).catch((e: unknown) => {
    if ((e as { aborted?: boolean }).aborted) patch(id, { state: "stopped", note: null });
    else patch(id, { state: "failed", error: errorMessage(e), note: null });
    throw e;
  });
}

export function stop(id: number) {
  runs.get(id)?.stop.abort();
}
export function retry(id: number) {
  const after = runs.get(id)?.after;
  go(id).then(
    () => after?.(),
    (e: unknown) => ((e as { aborted?: boolean }).aborted ? patch(id, { state: "stopped", note: null }) : patch(id, { state: "failed", error: errorMessage(e), note: null })),
  );
}
export function dismiss(id: number) {
  runs.delete(id);
  set(rows.filter((r) => r.id !== id));
}
