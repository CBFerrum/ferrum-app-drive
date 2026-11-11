import { describe, expect, it } from "vitest";
import { tooBig, versionMessage } from "./versionUpload";

describe("a new version", () => {
  it("refuses a file one upload cannot carry, and says the limit", () => {
    expect(tooBig({ name: "a.pdf", size: 10 }, { most: 100, carries: 100 })).toBeNull();
    expect(tooBig({ name: "a.pdf", size: 200 }, { carries: 100 })).toContain("200 B");
    expect(tooBig({ name: "a.pdf", size: 200 }, { most: 100, carries: null })).toContain("100 B");
    expect(tooBig({ name: "a.pdf", size: 5e9 }, {})).toBeNull();
  });
  it("says whether the file keeps its name", () => {
    expect(versionMessage({ name: "Report.pdf" }, { name: "report.PDF" })).not.toContain("keeps its name");
    expect(versionMessage({ name: "Report.pdf" }, { name: "Report v2.pdf" })).toContain("“Report.pdf”");
  });
});
