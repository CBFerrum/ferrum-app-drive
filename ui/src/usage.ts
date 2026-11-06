// How much of its space a person's Drive or a team folder uses, and how that is told: a meter that
// turns amber near the limit. Pure, so it is tested without a browser.

import { sizeLabel } from "./files";

/** `usage` as the server answers (`GET /api/app/drive/usage`); a quota of null is no limit. */
export interface Usage {
  space: { id: string; owner: string; root: string; quota_bytes: number | null; used_bytes: number };
  teams: { id: string; name: string; quota_bytes: number | null; used_bytes: number; permission: string }[];
  /** Whether the person administers Drive: makes team folders and sets their quotas. */
  admin: boolean;
  limits: { max_upload_bytes: number; request_bytes?: number; trash_days: number };
}

export interface Space {
  used: number;
  quota: number | null;
}

/** How full, from 0 to 1, or none when there is no limit. */
export const fullness = (s: Space): number | null => (s.quota && s.quota > 0 ? Math.min(1, s.used / s.quota) : null);

export type Tone = "ok" | "near" | "full";

/** Amber from four fifths, red at the limit. */
export function toneOf(s: Space): Tone {
  const f = fullness(s);
  return f === null || f < 0.8 ? "ok" : f < 1 ? "near" : "full";
}

/** "1.2 GB of 5 GB", or "1.2 GB" when nothing limits it. */
export const spaceLabel = (s: Space): string => (s.quota ? `${sizeLabel(s.used)} of ${sizeLabel(s.quota)}` : `${sizeLabel(s.used)} used`);

/** What is left, for the line under a meter that is nearly full. */
export function leftLabel(s: Space): string | null {
  if (!s.quota) return null;
  return s.used >= s.quota ? "No space left" : `${sizeLabel(s.quota - s.used)} left`;
}

const MB = 1024 * 1024;

/** A quota in megabytes (what the server takes) from a number of gigabytes a person typed; 0 or
 *  nothing means no limit. Null for something that is not a quantity. */
export function megabytesOf(gigabytes: string): number | null {
  const text = gigabytes.trim();
  if (!text) return 0;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1024) : null;
}

/** A quota in bytes as the gigabytes a person edits: 53687091200 → "50". */
export function gigabytesOf(bytes: number | null): string {
  if (!bytes) return "";
  const gb = bytes / MB / 1024;
  return String(Number.isInteger(gb) ? gb : Number(gb.toFixed(2)));
}
