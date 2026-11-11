// A large file sent in parts through the platform (`POST /api/files/uploads` with `parts`, `PUT …/parts/{offset}`,
// `…/complete`): each part with a watchdog on the bytes moving (a stalled line is taken for a lost one after 30
// seconds), sent again after a jittered, growing wait, and from where the server says the upload stands; going
// offline pauses it (no try is used up) and coming back goes on. When the tries are spent it stops with what
// was sent kept on the server, so asking again goes on from there, not from the start. Nothing here knows the page:
// it reports progress and takes a signal to stop.

import { ApiError, api, t } from "@ferrum/client";
import { TRIES, Watchdog, backoff, connectionLost, whenOnline } from "./stall";

interface PartsState {
  upload_id: string;
  size: number;
  offset: number;
  part_bytes: number;
  expires_at: string;
  parts?: boolean;
}

/** The request one part makes: the bytes of `body`, reporting each step (bytes moved so far), stopped by `signal`. */
export type Send = (method: "PUT" | "POST", url: string, body: Blob, step: (loaded: number) => void, signal: AbortSignal) => Promise<unknown>;

/** What a request failed with: `status` 0 is no answer (a drop, or a stall: `stalled`). */
export class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stalled = false,
    /** Every byte had gone out when it failed: the server may have the request. */
    readonly sentAll = false,
  ) {
    super(message);
  }
}

export const STALLED = () => t("The connection stopped responding.");

/** One request over XHR with a watchdog on its bytes (the upload's, then the answer's). */
export const sendWatched: Send = (method, url, body, step, signal) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    let all = false;
    const dog = new Watchdog(() => {
      x.abort();
      reject(new Refused(STALLED(), 0, true, all));
    });
    const end = () => dog.stop();
    x.open(method, url);
    x.setRequestHeader("accept", "application/json");
    x.upload.onprogress = (e) => {
      dog.poke();
      all = e.loaded >= e.total;
      step(e.loaded);
    };
    x.upload.onload = () => (all = true);
    x.onreadystatechange = () => dog.poke();
    x.onload = () => {
      end();
      let json: unknown = null;
      try {
        json = x.responseText ? JSON.parse(x.responseText) : null;
      } catch {
        json = x.responseText;
      }
      if (x.status >= 200 && x.status < 300) return resolve(json);
      const message = (json as { message?: string } | null)?.message ?? t("The server refused the file ({status}).", { status: x.status });
      reject(new Refused(message, x.status, false, all));
    };
    x.onerror = () => (end(), reject(new Refused(t("Cannot reach the server."), 0, false, all)));
    x.onabort = () => end();
    signal.addEventListener("abort", () => (x.abort(), reject(Object.assign(new Error("Stopped."), { aborted: true }))), { once: true });
    x.send(body);
  });

const KEPT = "drive.parts";
const keyOf = (f: File) => [f.name, f.size, f.lastModified].join("/");
const kept = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};
const keep = (list: Record<string, string>) => {
  try {
    if (Object.keys(list).length) localStorage.setItem(KEPT, JSON.stringify(list));
    else localStorage.removeItem(KEPT);
  } catch {
    // Not kept in this browser: asking again starts over.
  }
};
const forget = (key: string) => {
  const list = kept();
  delete list[key];
  keep(list);
};
const path = (id: string) => `/api/files/uploads/${encodeURIComponent(id)}`;

export interface Report {
  /** Bytes the server has acknowledged plus those of the part going out. */
  step: (sent: number) => void;
  /** What is happening when it is not simply sending. */
  note: (words: string | null) => void;
}

/** Sends `file`; resolves with the stored file. Rejects with a `Refused` once the tries are spent (what was sent stays), or with `aborted` when stopped. */
export async function uploadResumable(file: File, report: Report, signal: AbortSignal, send: Send = sendWatched, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const key = keyOf(file);
  const stands = async (id: string) => api.get<PartsState>(path(id));
  let up: PartsState | null = null;
  const id = kept()[key];
  if (id) {
    try {
      const s = await stands(id);
      if (s.parts !== false && s.size === file.size && Date.parse(s.expires_at) > Date.now()) up = s;
      else forget(key);
    } catch (e) {
      if (e instanceof ApiError && !connectionLost(e.status)) forget(key);
      else if (!(e instanceof ApiError) || connectionLost(e.status)) throw new Refused(STALLED(), 0);
    }
  }
  up ??= await api.post<PartsState>("/api/files/uploads", { file_name: file.name, content_type: file.type, size: file.size, parts: true });
  keep({ ...kept(), [key]: up.upload_id });
  let offset = up.offset;
  report.step(offset);
  for (let tries = 0; offset < file.size; ) {
    if (signal.aborted) throw Object.assign(new Error("Stopped."), { aborted: true });
    await whenOnline(signal);
    try {
      const part = file.slice(offset, offset + up.part_bytes);
      const answer = (await send("PUT", `${path(up.upload_id)}/parts/${offset}`, part, (n) => report.step(offset + n), signal)) as PartsState;
      offset = answer.offset;
      report.step(offset);
      report.note(null);
      tries = 0;
    } catch (e) {
      if ((e as { aborted?: boolean }).aborted) throw e;
      const status = e instanceof Refused ? e.status : 0;
      if (status === 409) {
        // The part arrived and its answer was lost: on from where the upload stands.
        const s = await stands(up.upload_id).catch(() => null);
        if (s && s.offset !== offset) {
          offset = s.offset;
          report.step(offset);
          continue;
        }
      }
      if (!connectionLost(status)) {
        if ([404, 409, 422].includes(status)) forget(key);
        throw e;
      }
      // Offline: wait for the connection, without using up a try.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        report.note(t("Waiting for the connection to come back"));
        continue;
      }
      if (++tries > TRIES) throw new Refused(STALLED(), 0, true);
      const ms = backoff(tries);
      report.note(t("The connection dropped. Trying again in {seconds} seconds ({tries} of {TRIES})", { seconds: Math.round(ms / 1000), tries, TRIES }));
      await wait(ms);
      // On from where the server says the upload stands (a part may have arrived whose answer was lost).
      const s = await stands(up.upload_id).catch(() => null);
      if (s) {
        offset = s.offset;
        report.step(offset);
      }
    }
  }
  const stored = await api.post<{ id: string }>(`${path(up.upload_id)}/complete`);
  forget(key);
  return stored;
}

/** A file sent in one request (a new version): stalls and drops before every byte was out are tried again after a wait; once every byte was out and the answer is missing, the server may have it, so it is not sent blindly again. */
export async function uploadSingle(file: Blob, url: string, report: Report, signal: AbortSignal, send: Send = sendWatched, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let tries = 0; ; ) {
    if (signal.aborted) throw Object.assign(new Error("Stopped."), { aborted: true });
    await whenOnline(signal);
    try {
      const answer = await send("POST", url, file, report.step, signal);
      report.note(null);
      return answer;
    } catch (e) {
      if ((e as { aborted?: boolean }).aborted) throw e;
      const refused = e instanceof Refused ? e : new Refused(String(e), 0);
      if (!connectionLost(refused.status)) throw refused;
      if (refused.sentAll) throw new Refused(t("The whole file went out but no answer came. It may have been added: look at the versions before sending it again."), 0, refused.stalled, true);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        report.note(t("Waiting for the connection to come back"));
        continue;
      }
      if (++tries > TRIES) throw new Refused(STALLED(), 0, true);
      const ms = backoff(tries);
      report.note(t("The connection dropped. Trying again in {seconds} seconds ({tries} of {TRIES})", { seconds: Math.round(ms / 1000), tries, TRIES }));
      await wait(ms);
    }
  }
}
