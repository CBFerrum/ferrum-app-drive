// Who can open an item and why: what was given to it directly, what comes down from the folders
// around it, and who it was sent to by link. Pure, so it is tested without a browser.

import type { Crumb } from "./files";
import { t } from "@ferrum/client";

/** A grant to a person or to everyone holding a role (`list_shares`). */
export interface Share {
  id: string;
  email?: string | null;
  role?: string | null;
  permission: string;
  expires_at?: string | null;
  shared_by?: string | null;
  /** The folder it was given to, when it comes down from there. */
  inherited_from?: string | null;
}

export interface Shares {
  owner?: string | null;
  team?: { id: string; name: string; members: { member: string; role: string }[] } | null;
  shares: Share[];
}

export interface Inherited {
  folder: string;
  name: string;
  shares: Share[];
}

/** The shares given to the item itself, and those that come down from folders above it, the nearest
 *  folder first. `path` is the folders above the item as the person sees them, outermost first. */
export function groupShares(shares: Share[], path: Crumb[]): { direct: Share[]; inherited: Inherited[] } {
  const direct = shares.filter((s) => !s.inherited_from);
  const from = new Map<string, Share[]>();
  for (const s of shares) if (s.inherited_from) from.set(s.inherited_from, [...(from.get(s.inherited_from) ?? []), s]);
  const depth = (id: string) => path.findIndex((c) => c.id === id);
  const inherited = [...from.entries()]
    .sort(([a], [b]) => depth(b) - depth(a))
    .map(([folder, list]) => ({ folder, name: path.find((c) => c.id === folder)?.name ?? "a folder above", shares: list }));
  return { direct, inherited };
}

/** Who a share is for, in words. */
export const shareFor = (s: Pick<Share, "email" | "role">) => s.email ?? (s.role ? t("Everyone with the role {role}", { role: s.role }) : "Someone");

/** The addresses in text typed or pasted into a box: split at commas, semicolons, spaces and lines,
 *  lower-cased, each once, and only what looks like an address. `rest` is what was left over. */
export function addresses(text: string): { emails: string[]; rest: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.replace(/^[<"']+|[>"']+$/g, "").toLowerCase())
    .filter(Boolean);
  const emails: string[] = [];
  const rest: string[] = [];
  for (const p of parts) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) {
      if (!emails.includes(p)) emails.push(p);
    } else rest.push(p);
  }
  return { emails, rest };
}
