// The bar's tray (`shell().uploads.track`): where a transfer Drive carries itself shows when the bar can track it,
// reported through the handle it gives. The shape is declared here until the client types it (then these types
// come from `@ferrum/client` and `canTrack` replaces `trayOf`).

import { errorMessage, shell } from "@ferrum/client";
import type { Report } from "./partsUpload";

export interface TrayHandle {
  id: string;
  progress(bytes: number): void;
  retrying(message?: string): void;
  sending(): void;
  done(): void;
  fail(message?: string): void;
}
export interface Tray {
  track(o: { label: string; size: number; cancel?: () => void; retry?: () => void }): Promise<TrayHandle>;
}

/** The tray of a shell that has one; none for an older server. */
export const trayOf = (s: unknown = shell()): Tray | null => {
  const u = (s as { uploads?: Partial<Tray> } | null | undefined)?.uploads;
  return u && typeof u.track === "function" ? (u as Tray) : null;
};

export type Run = (report: Report, signal: AbortSignal) => Promise<unknown>;

/**
 * Runs `run` as a row of the bar's tray. Resolves to `{ ran }`, the first try's promise (stopped or failed rejects, as Drive's
 * own panel does), or to null when the tray cannot take it (the caller shows its own panel). Stop in the bar aborts
 * the try; Retry in the bar runs it again through the same handle, then calls `after`.
 */
export async function trackInBar(tray: Tray | null, file: { name: string; size: number }, run: Run, after?: () => void): Promise<{ ran: Promise<unknown> } | null> {
  if (!tray) return null;
  let stop = new AbortController();
  let handle: TrayHandle | undefined;
  const attempt = () => {
    stop = new AbortController();
    const h = handle!;
    return run({ step: (sent) => h.progress(sent), note: (words) => (words ? h.retrying(words) : h.sending()) }, stop.signal).then(
      () => h.done(),
      (e: unknown) => {
        // A Stop was the bar's own doing: it already shows the row as stopped.
        if (!(e as { aborted?: boolean }).aborted) h.fail(errorMessage(e));
        throw e;
      },
    );
  };
  try {
    handle = await tray.track({
      label: file.name,
      size: file.size,
      cancel: () => stop.abort(),
      retry: () => void attempt().then(() => after?.(), () => {}),
    });
  } catch {
    return null;
  }
  return { ran: attempt() };
}
