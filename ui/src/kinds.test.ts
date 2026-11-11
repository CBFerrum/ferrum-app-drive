import { describe, expect, it } from "vitest";
import { lookOf } from "./files";
import { THUMB_MAX, previewKind, thumbnailable } from "./kinds";

describe("kinds", () => {
  it("says how each file is shown", () => {
    const kinds = ["a.PNG", "a.mp4", "a.mp3", "a.pdf", "a.md", "a.csv", "a.json", "a.py", "a.txt", "a.docx", "a.fdoc", "a.zip", "README", "a.xyz"].map((n) => previewKind(n));
    expect(kinds).toEqual(["image", "video", "audio", "pdf", "markdown", "csv", "json", "code", "text", "office", "live", "none", "none", "none"]);
    expect(previewKind("notes", "Text")).toBe("text");
  });
  it("gives each kind of file its own look", () => {
    expect(["a.docx", "a.xlsx", "a.pptx", "a.pdf", "a.png", "a.mp4", "a.mp3", "a.zip", "a.py", "a.bin"].map((n) => lookOf("file", n))).toEqual(["text", "sheet", "slides", "pdf", "image", "video", "audio", "archive", "code", "file"]);
    expect(lookOf("folder", "x")).toBe("folder");
  });
  it("fetches a thumbnail only for a small image the browser draws", () => {
    expect([thumbnailable("a.jpg", 1000), thumbnailable("a.jpg", THUMB_MAX + 1), thumbnailable("a.svg", 10), thumbnailable("a.pdf", 10), thumbnailable("a.png", null)]).toEqual([true, false, false, false, false]);
  });
});
