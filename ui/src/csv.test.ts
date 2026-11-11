import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("reads quoted cells with commas, quotes and line breaks", () => {
    const t = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\n2,"two\nlines",\n', 10);
    expect(t.rows).toEqual([["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "two\nlines", ""]]);
    expect(t.total).toBe(3);
  });
  it("guesses tabs and semicolons, skips a byte-order mark and blank lines", () => {
    expect(parseCsv("﻿a\tb\n\n1\t2", 10).rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a;b;c\n1;2;3", 10).rows[1]).toEqual(["1", "2", "3"]);
  });
  it("keeps the first rows and counts the rest", () => {
    const t = parseCsv(Array.from({ length: 1500 }, (_, i) => `${i},x`).join("\n"), 500);
    expect([t.rows.length, t.total, t.rows[499][0]]).toEqual([500, 1500, "499"]);
  });
  it("copes with empty text and a missing final newline", () => {
    expect(parseCsv("", 5)).toEqual({ rows: [], total: 0 });
    expect(parseCsv("a,b", 5).rows).toEqual([["a", "b"]]);
  });
});
