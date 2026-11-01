// Which items a Drive page lists and in what order: its views, the sort and the filter chips (kept
// in the address, so a link shows the same list), where the server can do the sorting and
// filtering and where the page does it. Pure, so it is tested without a browser.

import { type Item, shownName } from "./files";

/** Drive's views besides a folder of your own (`?view=`). */
export const VIEWS = [
  { id: "mine", label: "My files", action: "" },
  { id: "shared", label: "Shared with me", action: "shared_with_me" },
  { id: "recent", label: "Recent", action: "recent" },
  { id: "starred", label: "Starred", action: "starred" },
  { id: "trash", label: "Trash", action: "list_trash" },
] as const;
export type View = (typeof VIEWS)[number]["id"];

export const viewOf = (param: string | null): View => VIEWS.find((v) => v.id === param)?.id ?? "mine";

export const SORTS = [
  { id: "name", label: "Name" },
  { id: "modified", label: "Modified" },
  { id: "size", label: "Size" },
  { id: "type", label: "Type" },
] as const;
export type SortKey = (typeof SORTS)[number]["id"];
export type Order = "asc" | "desc";

/** The way each sort reads most naturally: names from A, the newest and biggest first. */
export const naturalOrder = (sort: SortKey): Order => (sort === "name" || sort === "type" ? "asc" : "desc");

/** What a file is, as the server tells it (`file_type`), for the Type chip. */
export const TYPES = [
  { id: "folder", label: "Folders" },
  { id: "Document", label: "Documents" },
  { id: "Spreadsheet", label: "Spreadsheets" },
  { id: "Presentation", label: "Presentations" },
  { id: "PDF", label: "PDFs" },
  { id: "Image", label: "Images" },
  { id: "Video", label: "Videos" },
  { id: "Audio", label: "Audio" },
  { id: "Archive", label: "Archives" },
  { id: "Text", label: "Text files" },
  { id: "Other", label: "Other" },
] as const;

/** How recently a file changed, for the Modified chip (days back, today counted). */
export const SINCE = [
  { days: 1, label: "Today" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 365, label: "Last year" },
] as const;

/** The sort and the filters of a page, as its address keeps them. A sort of none is the list's own
 *  order: names in a folder, newest first in a search, as delivered in the other views. */
export interface Query {
  sort: SortKey | null;
  order: Order | null;
  type: string | null;
  since: number | null;
  owner: string | null;
}

export const QUERY_KEYS = ["sort", "order", "type", "since", "owner"] as const;

export function readQuery(params: URLSearchParams): Query {
  const sort = SORTS.find((s) => s.id === params.get("sort"))?.id ?? null;
  const order = params.get("order");
  const type = TYPES.find((t) => t.id === params.get("type"))?.id ?? null;
  const since = SINCE.find((s) => String(s.days) === params.get("since"))?.days ?? null;
  return { sort, order: order === "asc" || order === "desc" ? order : null, type, since, owner: params.get("owner")?.trim().toLowerCase() || null };
}

/** How many filters a page has on. */
export const filtersOn = (q: Query) => [q.type, q.since, q.owner].filter(Boolean).length;

/** Where a page's items come from. */
export type Source =
  /** `list_folder`: a folder's own items, sorted by the server. */
  | { kind: "folder"; folder: string }
  /** `search`: filtered and sorted by the server; within a folder, everything in it and below. */
  | { kind: "search"; query?: string; type?: string; folder?: string }
  /** Shared with me, recent and starred: the whole list at once, sorted and filtered here. */
  | { kind: "view"; view: "shared" | "recent" | "starred" }
  /** `list_trash`. */
  | { kind: "trash" };

/** The source of the page named by its address. Filters turn a folder into a search of it. */
export function sourceOf(o: { view: View; folder?: string; query: string; fileType?: string; q: Query }): Source | null {
  if (o.query || o.fileType) return { kind: "search", query: o.query || undefined, type: o.fileType };
  if (o.view === "mine") {
    if (!o.folder) return null;
    return o.q.type || o.q.since || o.q.owner ? { kind: "search", folder: o.folder } : { kind: "folder", folder: o.folder };
  }
  return o.view === "trash" ? { kind: "trash" } : { kind: "view", view: o.view };
}

/** What a source lets a person choose: the sorts it can do, whether the direction is theirs, and
 *  whether it filters. */
export function abilities(src: Source | null, fileType?: string): { sorts: SortKey[]; direction: boolean; filter: boolean; type: boolean } {
  const all = SORTS.map((s) => s.id);
  if (!src || src.kind === "trash") return { sorts: [], direction: false, filter: false, type: false };
  // The server's search sorts by name, newest and biggest, each one way.
  if (src.kind === "search") return { sorts: ["name", "modified", "size"], direction: false, filter: true, type: !fileType };
  return { sorts: all, direction: true, filter: true, type: true };
}

/** The sort a source uses when the address names none. */
export function defaultSort(src: Source | null): SortKey | null {
  return src?.kind === "folder" ? "name" : src?.kind === "search" ? "modified" : null;
}

/** `YYYY-MM-DD`, `days` before `today` (also a calendar day). */
export function daysAgo(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** The query of a `search` call for a source and the chips on. */
export function searchQuery(src: Extract<Source, { kind: "search" }>, q: Query, today: string): Record<string, string | undefined> {
  return {
    query: src.query,
    type: src.type ?? q.type ?? undefined,
    folder: src.folder,
    owner: q.owner ?? undefined,
    modified_from: q.since ? daysAgo(today, q.since - 1) : undefined,
    // The server's search has no sort by type.
    sort: q.sort && q.sort !== "type" ? q.sort : undefined,
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then files, each group in the order asked for; ties by name. */
export function sortItems(items: Item[], sort: SortKey, order: Order): Item[] {
  const dir = order === "desc" ? -1 : 1;
  const number = (i: Item) => (sort === "modified" ? Date.parse(i.modified_at) || 0 : (i.size ?? -1));
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const by =
      sort === "modified" || sort === "size"
        ? number(a) - number(b)
        : collator.compare(sort === "type" ? (a.file_type ?? "") : shownName(a.name), sort === "type" ? (b.file_type ?? "") : shownName(b.name));
    return by * dir || collator.compare(shownName(a.name), shownName(b.name));
  });
}

/** The items a set of filters keeps (for lists the page has whole). `now` is a clock for tests. */
export function filterItems(items: Item[], q: Pick<Query, "type" | "since" | "owner">, now = new Date()): Item[] {
  const from = q.since ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (q.since - 1)).getTime() : null;
  return items.filter(
    (i) =>
      (!q.type || (q.type === "folder" ? i.kind === "folder" : i.kind === "file" && i.file_type === q.type)) &&
      (from === null || (Date.parse(i.modified_at) || 0) >= from) &&
      (!q.owner || i.owner?.toLowerCase() === q.owner),
  );
}

/** Pages of a list as one, without an item twice (a list that changed between two requests). */
export function flatten<T extends { id: string }>(pages: { items: T[] }[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages)
    for (const item of page.items)
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
  return out;
}

/** The offset after a page that began at `offset` and held `count` items, or none when it was the
 *  last. `total` is for the lists that say how many there are; the others say whether more follow. */
export function nextOffset(offset: number, count: number, more: { total: number } | { hasMore: boolean }): number | undefined {
  const next = offset + count;
  if (!count) return undefined;
  return "total" in more ? (next < more.total ? next : undefined) : more.hasMore ? next : undefined;
}

/** How a count of items reads under a list: "300 of 1,340". */
export function shownOf(shown: number, total: number | null): string {
  return total !== null && total > shown ? `${shown.toLocaleString()} of ${total.toLocaleString()}` : shown.toLocaleString();
}

/** The line under an item's name: where a search found it or the words it found, who shared it, who
 *  owns it where the list holds more than one person's. */
export function whereLine(i: Item, view: View, inFolder: boolean): string | null {
  if (i.snippet) return i.snippet;
  const parts: string[] = [];
  if (view === "shared" && i.shared_by) parts.push(`Shared by ${i.shared_by}`);
  else if (!inFolder && i.owner) parts.push(i.owner);
  if (i.path) parts.push(i.path);
  return parts.length ? parts.join(" · ") : null;
}

/** What an empty list says, and what to do about it. */
export function emptyText(o: { view: View; query: string; filtered: boolean; canAdd: boolean; kind?: string; trashDays?: number }): { title: string; hint: string } {
  if (o.query) return { title: `Nothing matches “${o.query}”`, hint: o.filtered ? "Take a filter off, or try another word." : "Try another word, or part of a name." };
  if (o.filtered) return { title: "Nothing matches these filters", hint: "Take a filter off to see more." };
  if (o.kind) return { title: `No ${o.kind} yet`, hint: o.canAdd ? "Make one with New, or upload one." : "The ones you can open show up here." };
  switch (o.view) {
    case "shared":
      return { title: "Nothing has been shared with you", hint: "When someone shares a file or a folder with you, it shows up here." };
    case "recent":
      return { title: "No recent files", hint: "Files you upload, open or change show up here for 90 days." };
    case "starred":
      return { title: "No starred items", hint: "Star a file or a folder to find it here again." };
    case "trash":
      return { title: "The trash is empty", hint: `What you move to the trash stays here for ${o.trashDays ?? 30} days, and can be restored.` };
    default:
      return { title: "This folder is empty", hint: o.canAdd ? "Drop files here, or use Upload or New." : "Nothing has been put in it yet." };
  }
}
