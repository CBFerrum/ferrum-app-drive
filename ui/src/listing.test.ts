import { describe, expect, it } from "vitest";
import type { Item } from "./files";
import { abilities, daysAgo, defaultSort, filterItems, emptyText, filtersOn, flatten, nextOffset, readQuery, searchQuery, shownOf, sortItems, sourceOf, viewOf, whereLine } from "./listing";

const item = (id: string, name: string, extra: Partial<Item> = {}): Item => ({
  id,
  kind: "file",
  name,
  size: 100,
  modified_at: "2026-11-01T10:00:00Z",
  modified_by: null,
  permission: "Edit",
  locked_by: null,
  file_type: "Document",
  ...extra,
});
const folder = (id: string, name: string, extra: Partial<Item> = {}) => item(id, name, { kind: "folder", size: null, file_type: null, ...extra });

describe("a page's list", () => {
  it("reads the sort and the chips from the address, and ignores what it does not know", () => {
    const q = readQuery(new URLSearchParams("sort=size&order=asc&type=PDF&since=7&owner=Ana@Acme.test"));
    expect(q).toEqual({ sort: "size", order: "asc", type: "PDF", since: 7, owner: "ana@acme.test" });
    expect(readQuery(new URLSearchParams("sort=colour&order=up&type=Spaceship&since=3"))).toEqual({ sort: null, order: null, type: null, since: null, owner: null });
    expect(filtersOn(q)).toBe(3);
    expect(viewOf("starred")).toBe("starred");
    expect(viewOf("nonsense")).toBe("mine");
    expect(viewOf(null)).toBe("mine");
  });

  it("takes a folder from the server, a search when chips are on, and a view whole", () => {
    const none = readQuery(new URLSearchParams());
    const pdf = readQuery(new URLSearchParams("type=PDF"));
    expect(sourceOf({ view: "mine", folder: "f1", query: "", q: none })).toEqual({ kind: "folder", folder: "f1" });
    expect(sourceOf({ view: "mine", folder: "f1", query: "", q: pdf })).toEqual({ kind: "search", folder: "f1" });
    expect(sourceOf({ view: "mine", query: "", q: none })).toBeNull();
    expect(sourceOf({ view: "mine", folder: "f1", query: "plan", q: none })).toEqual({ kind: "search", query: "plan", type: undefined });
    expect(sourceOf({ view: "mine", query: "", fileType: "Spreadsheet", q: none })).toEqual({ kind: "search", query: undefined, type: "Spreadsheet" });
    expect(sourceOf({ view: "shared", query: "", q: none })).toEqual({ kind: "view", view: "shared" });
    expect(sourceOf({ view: "trash", query: "", q: none })).toEqual({ kind: "trash" });
  });

  it("offers each source what it can do", () => {
    expect(abilities({ kind: "folder", folder: "f" })).toMatchObject({ direction: true, filter: true, type: true });
    expect(abilities({ kind: "search", query: "x" })).toEqual({ sorts: ["name", "modified", "size"], direction: false, filter: true, type: true });
    expect(abilities({ kind: "search", type: "PDF" }, "PDF").type).toBe(false);
    expect(abilities({ kind: "trash" })).toEqual({ sorts: [], direction: false, filter: false, type: false });
    expect(defaultSort({ kind: "folder", folder: "f" })).toBe("name");
    expect(defaultSort({ kind: "search" })).toBe("modified");
    expect(defaultSort({ kind: "view", view: "recent" })).toBeNull();
  });

  it("counts days back from a calendar day, across months and years", () => {
    expect(daysAgo("2026-11-01", 0)).toBe("2026-11-01");
    expect(daysAgo("2026-11-01", 1)).toBe("2026-10-31");
    expect(daysAgo("2026-03-01", 1)).toBe("2026-02-28");
    expect(daysAgo("2026-01-02", 6)).toBe("2025-12-27");
    expect(daysAgo("2026-11-01", -6)).toBe("2026-11-07");
  });

  it("asks the server's search for what the chips say", () => {
    const q = readQuery(new URLSearchParams("sort=type&type=Image&since=7&owner=ana@acme.test"));
    expect(searchQuery({ kind: "search", folder: "f1" }, q, "2026-11-10")).toEqual({
      query: undefined,
      type: "Image",
      folder: "f1",
      owner: "ana@acme.test",
      modified_from: "2026-11-04",
      sort: undefined,
    });
    // A page of one kind of file keeps its kind whatever chips say.
    expect(searchQuery({ kind: "search", type: "PDF" }, q, "2026-11-10").type).toBe("PDF");
    expect(searchQuery({ kind: "search", query: "plan" }, readQuery(new URLSearchParams("sort=size")), "2026-11-10")).toMatchObject({ query: "plan", sort: "size" });
  });

  it("puts folders first whichever way it sorts, and ties by name", () => {
    const list = [
      item("1", "b.txt", { size: 5, modified_at: "2026-10-01T00:00:00Z", file_type: "Text" }),
      item("2", "a.pdf", { size: 50, modified_at: "2026-10-03T00:00:00Z", file_type: "PDF" }),
      folder("3", "Zoo"),
      item("4", "c.pdf", { size: 50, modified_at: "2026-10-02T00:00:00Z", file_type: "PDF" }),
      folder("5", "alpha"),
    ];
    const ids = (sort: Parameters<typeof sortItems>[1], order: "asc" | "desc") => sortItems(list, sort, order).map((i) => i.id);
    expect(ids("name", "asc")).toEqual(["5", "3", "2", "1", "4"]);
    expect(ids("name", "desc")).toEqual(["3", "5", "4", "1", "2"]);
    expect(ids("size", "desc")).toEqual(["5", "3", "2", "4", "1"]);
    expect(ids("modified", "desc")).toEqual(["5", "3", "2", "4", "1"]);
    expect(ids("modified", "asc")).toEqual(["5", "3", "1", "4", "2"]);
    expect(ids("type", "asc")).toEqual(["5", "3", "2", "4", "1"]);
    expect(list.map((i) => i.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("sorts numbers inside names as numbers, and a live document by its shown name", () => {
    const names = sortItems([item("1", "file10.txt"), item("2", "file9.txt"), item("3", "Notes.fdoc"), item("4", "alpha.txt")], "name", "asc").map((i) => i.name);
    expect(names).toEqual(["alpha.txt", "file9.txt", "file10.txt", "Notes.fdoc"]);
  });

  it("keeps what the chips ask for, in a list it has whole", () => {
    const now = new Date(2026, 10, 10, 15, 0);
    const list = [
      folder("f", "Reports", { modified_at: new Date(2026, 10, 10, 9, 0).toISOString() }),
      item("a", "plan.pdf", { file_type: "PDF", owner: "ana@acme.test", modified_at: new Date(2026, 10, 4, 12, 0).toISOString() }),
      item("b", "old.pdf", { file_type: "PDF", owner: "Ben@acme.test", modified_at: new Date(2026, 8, 1).toISOString() }),
      item("c", "notes.txt", { file_type: "Text", owner: "ana@acme.test", modified_at: new Date(2026, 10, 10, 8, 0).toISOString() }),
    ];
    const ids = (q: Parameters<typeof filterItems>[1]) => filterItems(list, q, now).map((i) => i.id);
    expect(ids({ type: "PDF", since: null, owner: null })).toEqual(["a", "b"]);
    expect(ids({ type: "folder", since: null, owner: null })).toEqual(["f"]);
    expect(ids({ type: null, since: 1, owner: null })).toEqual(["f", "c"]);
    expect(ids({ type: null, since: 7, owner: null })).toEqual(["f", "a", "c"]);
    expect(ids({ type: null, since: null, owner: "ben@acme.test" })).toEqual(["b"]);
    expect(ids({ type: "PDF", since: 7, owner: "ana@acme.test" })).toEqual(["a"]);
    expect(ids({ type: null, since: null, owner: null })).toEqual(["f", "a", "b", "c"]);
  });

  it("joins pages without an item twice", () => {
    const a = item("a", "a.txt");
    const b = item("b", "b.txt");
    const c = item("c", "c.txt");
    expect(flatten([{ items: [a, b] }, { items: [b, c] }]).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(flatten([])).toEqual([]);
  });

  it("asks for the next page only while there is one", () => {
    expect(nextOffset(0, 100, { total: 340 })).toBe(100);
    expect(nextOffset(300, 40, { total: 340 })).toBeUndefined();
    expect(nextOffset(100, 100, { hasMore: true })).toBe(200);
    expect(nextOffset(100, 37, { hasMore: false })).toBeUndefined();
    expect(nextOffset(100, 0, { hasMore: true })).toBeUndefined();
  });

  it("says how many are shown of how many there are", () => {
    expect(shownOf(300, 1340)).toBe((300).toLocaleString() + " of " + (1340).toLocaleString());
    expect(shownOf(12, 12)).toBe("12");
    expect(shownOf(12, null)).toBe("12");
  });

  it("says under a name what helps tell it from others", () => {
    const a = item("a", "plan.pdf", { owner: "ana@acme.test", path: "Team / Plans", shared_by: "ben@acme.test" });
    expect(whereLine(a, "mine", true)).toBe("Team / Plans");
    expect(whereLine(a, "mine", false)).toBe("ana@acme.test · Team / Plans");
    expect(whereLine(a, "shared", false)).toBe("Shared by ben@acme.test · Team / Plans");
    expect(whereLine({ ...a, snippet: "Risks · The «venue» may move" }, "mine", false)).toBe("Risks · The «venue» may move");
    expect(whereLine(item("b", "b.txt"), "recent", false)).toBeNull();
  });

  it("says what an empty list is for", () => {
    const base = { view: "mine" as const, query: "", filtered: false, canAdd: true };
    expect(emptyText(base).hint).toBe("Drop files here, or use Upload or New.");
    expect(emptyText({ ...base, canAdd: false }).hint).toBe("Nothing has been put in it yet.");
    expect(emptyText({ ...base, query: "plan" }).title).toBe("Nothing matches “plan”");
    expect(emptyText({ ...base, filtered: true }).title).toBe("Nothing matches these filters");
    expect(emptyText({ ...base, kind: "spreadsheets" })).toEqual({ title: "No spreadsheets yet", hint: "Make one with New, or upload one." });
    expect(emptyText({ ...base, view: "trash", trashDays: 14 }).hint).toBe("What you move to the trash stays here for 14 days, and can be restored.");
    expect(emptyText({ ...base, view: "shared" }).title).toBe("Nothing has been shared with you");
    expect(["recent", "starred"].map((view) => emptyText({ ...base, view: view as "recent" | "starred" }).title)).toEqual(["No recent files", "No starred items"]);
  });
});
