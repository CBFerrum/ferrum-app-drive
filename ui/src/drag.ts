// Moving and copying by dragging: what a drag carries, where it may be dropped and whether the
// drop moves or copies. Every drag has a menu or key to do the same (the destination picker).
// Pure, so it is tested without a browser.

import type { Item } from "./files";
import { allows } from "./files";

/** What a drag of Drive's own items carries (a drag of files from the computer carries `Files`). */
export const CARRIES = "application/x-ferrum-drive-items";

export type Carried = Pick<Item, "id" | "kind" | "name" | "parent">;

export const carry = (items: Carried[]): string => JSON.stringify(items.map(({ id, kind, name, parent }) => ({ id, kind, name, parent: parent ?? null })));

/** The items a drag carries, or none for a drag of anything else. */
export function carried(raw: string): Carried[] {
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((i): i is Carried => !!i && typeof i.id === "string" && (i.kind === "file" || i.kind === "folder") && typeof i.name === "string") : [];
  } catch {
    return [];
  }
}

/** Whether a drag brings files from the computer. */
export const bringsFiles = (types: ArrayLike<string> | Iterable<string>): boolean => Array.from(types as Iterable<string>).includes("Files");

/** Whether a drag is one of Drive's own items. */
export const bringsItems = (types: ArrayLike<string> | Iterable<string>): boolean => Array.from(types as Iterable<string>).includes(CARRIES);

/** A key held down while dropping asks for a copy (Ctrl, or Option on a Mac). */
export const copying = (e: { ctrlKey: boolean; altKey: boolean }) => e.ctrlKey || e.altKey;

/** Whether `items` may be dropped on the folder `to`: it takes what the person may add to it, and
 *  not a folder inside itself. A move into the folder the items are in changes nothing. */
export function canDropOn(items: Carried[], to: { id: string; permission?: string }, copy: boolean): boolean {
  if (!items.length) return false;
  if (to.permission !== undefined && !allows(to.permission, "Edit")) return false;
  if (items.some((i) => i.id === to.id)) return false;
  return copy || items.some((i) => (i.parent ?? null) !== to.id);
}

/** The items a drag of `row` carries: the choice when the row is part of it, else the row alone. */
export function dragged<T extends { id: string }>(row: T, chosen: ReadonlySet<string>, items: T[]): T[] {
  return chosen.has(row.id) ? items.filter((i) => chosen.has(i.id)) : [row];
}
