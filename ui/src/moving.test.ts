import { describe, expect, it } from "vitest";
import { each, items, told } from "./bulk";
import { CARRIES, bringsFiles, bringsItems, canDropOn, carried, carry, copying, dragged } from "./drag";

const file = (id: string, name: string, parent: string | null = "root") => ({ id, kind: "file" as const, name, parent });
const folder = (id: string, name: string, parent: string | null = "root") => ({ id, kind: "folder" as const, name, parent });

describe("dragging items", () => {
  it("carries items as the drag's data and reads them back", () => {
    const raw = carry([file("f1", "plan.docx"), folder("d1", "Reports")]);
    expect(carried(raw).map((i) => [i.id, i.kind, i.name])).toEqual([
      ["f1", "file", "plan.docx"],
      ["d1", "folder", "Reports"],
    ]);
    expect(carried("not json")).toEqual([]);
    expect(carried('{"id":"x"}')).toEqual([]);
    expect(carried('[{"id":1,"kind":"file","name":"x"},{"id":"y","kind":"thing","name":"y"}]')).toEqual([]);
  });

  it("tells a drag of files from the computer from a drag of Drive's items", () => {
    expect(bringsFiles(["Files", "text/plain"])).toBe(true);
    expect(bringsFiles(["text/plain"])).toBe(false);
    expect(bringsItems([CARRIES, "text/plain"])).toBe(true);
    expect(bringsItems(["Files"])).toBe(false);
  });

  it("copies with Ctrl or Option held", () => {
    expect(copying({ ctrlKey: true, altKey: false })).toBe(true);
    expect(copying({ ctrlKey: false, altKey: true })).toBe(true);
    expect(copying({ ctrlKey: false, altKey: false })).toBe(false);
  });

  it("allows a drop on a folder the person may add to, and not on a folder inside itself", () => {
    const carrying = [file("f1", "a.txt", "src"), folder("d1", "Reports", "src")];
    expect(canDropOn(carrying, { id: "dst", permission: "Edit" }, false)).toBe(true);
    expect(canDropOn(carrying, { id: "dst", permission: "Manage" }, false)).toBe(true);
    expect(canDropOn(carrying, { id: "dst", permission: "View" }, false)).toBe(false);
    expect(canDropOn(carrying, { id: "dst" }, false)).toBe(true);
    expect(canDropOn(carrying, { id: "d1", permission: "Edit" }, false)).toBe(false);
    expect(canDropOn([], { id: "dst" }, false)).toBe(false);
  });

  it("sees that moving an item where it is changes nothing, while copying it there is a copy", () => {
    const here = [file("f1", "a.txt", "src")];
    expect(canDropOn(here, { id: "src", permission: "Edit" }, false)).toBe(false);
    expect(canDropOn(here, { id: "src", permission: "Edit" }, true)).toBe(true);
    expect(canDropOn([...here, file("f2", "b.txt", "other")], { id: "src", permission: "Edit" }, false)).toBe(true);
  });

  it("drags the choice when the row is part of it, else the row alone", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(dragged(rows[1], new Set(["a", "b"]), rows)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(dragged(rows[2], new Set(["a", "b"]), rows)).toEqual([{ id: "c" }]);
    expect(dragged(rows[0], new Set(), rows)).toEqual([{ id: "a" }]);
  });
});

describe("acting on several items", () => {
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

  it("tries every item in turn, and goes on after one fails", async () => {
    const seen: string[] = [];
    const out = await each(
      [{ name: "a" }, { name: "b" }, { name: "c" }],
      async (i) => {
        seen.push(i.name);
        if (i.name === "b") throw new Error("a file of that name is there already");
      },
      reason,
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(out.done.map((i) => i.name)).toEqual(["a", "c"]);
    expect(out.failed).toEqual([{ item: { name: "b" }, reason: "a file of that name is there already" }]);
  });

  it("says what was done", () => {
    const verb = { done: "Moved", doing: "move" };
    expect(told(verb, { done: [{ name: "a" }], failed: [] }, "to “Reports”")).toEqual({ message: "Moved 1 item to “Reports”", error: false });
    expect(told(verb, { done: [{ name: "a" }, { name: "b" }], failed: [] })).toEqual({ message: "Moved 2 items", error: false });
  });

  it("gives the server's reason for the first that failed", () => {
    const verb = { done: "Moved", doing: "move" };
    expect(told(verb, { done: [], failed: [{ item: { name: "Q3.xlsx" }, reason: "A file of that name is there already" }] })).toEqual({
      message: "Could not move “Q3.xlsx”: A file of that name is there already",
      error: true,
    });
    const some = told(verb, { done: [{ name: "a" }], failed: [{ item: { name: "b" }, reason: "No" }, { item: { name: "c" }, reason: "No" }] }, "to “Reports”");
    expect(some).toEqual({ message: "Moved 1 of 3 items to “Reports”. “b”: No (and 1 more)", error: true });
  });

  it("names what was done in the words that fit, files for an upload", () => {
    const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
    expect(told({ done: "Uploaded", doing: "upload" }, { done: [{ name: "a" }, { name: "b" }], failed: [] }, undefined, files)).toEqual({ message: "Uploaded 2 files", error: false });
    expect(told({ done: "Shared", doing: "share" }, { done: [{ name: "a" }], failed: [] }, "with ana@acme.test")).toEqual({ message: "Shared 1 item with ana@acme.test", error: false });
  });

  it("counts items", () => {
    expect([1, 2, 0].map(items)).toEqual(["1 item", "2 items", "0 items"]);
  });
});
