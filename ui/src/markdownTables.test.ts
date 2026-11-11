import { describe, expect, it } from "vitest";
import { splitTables } from "./markdownTables";

describe("tables in a note", () => {
  it("cuts a table out and leaves the text around it", () => {
    const pieces = splitTables("# Plan\n\n| Owner | Due |\n|:--|--:|\n| Priya | 14 Nov |\n| Omar | 18 Nov |\n\nAfter.");
    expect(pieces.map((p) => p.kind)).toEqual(["text", "table", "text"]);
    const table = pieces[1];
    if (table.kind !== "table") throw new Error("not a table");
    expect([table.head, table.rows, table.align]).toEqual([["Owner", "Due"], [["Priya", "14 Nov"], ["Omar", "18 Nov"]], ["start", "end"]]);
  });
  it("does not take a table drawn inside a code fence, or a line with a bar", () => {
    expect(splitTables("```\n| a | b |\n|---|---|\n```\nx | y").every((p) => p.kind === "text")).toBe(true);
  });
});
