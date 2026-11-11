import { describe, expect, it } from "vitest";
import { clashes, decide, nameKey } from "./clash";

const f = (name: string, path: string[] = []) => ({ path, file: { name } as File });

describe("a name that is taken", () => {
  it("finds the loose files whose name is in the folder, whatever the case", () => {
    const taken = new Set(["report.pdf", "notes.txt"]);
    const found = clashes([f("Report.PDF"), f("new.txt"), f("notes.txt", ["Sub"]), f(" notes.txt ")], taken);
    expect(found.map((x) => x.file.name)).toEqual(["Report.PDF", " notes.txt "]);
    expect(nameKey(" A.B ")).toBe("a.b");
  });
  it("applies one answer to all, or each answer to its file", () => {
    const names = ["a", "b", "c"];
    expect([...decide(names, [{ name: "a", choice: "skip", all: false }, { choice: "replace", all: true }])]).toEqual([["a", "skip"], ["b", "replace"], ["c", "replace"]]);
    expect(decide(names, [{ name: "a", choice: "both", all: false }]).has("b")).toBe(false);
  });
});
