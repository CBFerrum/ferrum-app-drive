import { describe, expect, it } from "vitest";
import { copyName, readOnlyReason } from "./BrowserEdit";
import { allows } from "./Details";
import { joinable, presenceLabel } from "./presence";
import { roleLabel } from "./Share";
import { type BrowserEditor, defaultEditor, editable, editorsFor, extension, sizeLabel } from "./Drive";

describe("drive", () => {
  it("knows which files the editor opens", () => {
    for (const n of ["Plan.docx", "budget.XLSX", "deck.pptx", "notes.odt", "old.doc", "data.csv"]) expect(editable(n), n).toBe(true);
    for (const n of ["photo.png", "report.pdf", "docx", "archive.zip"]) expect(editable(n), n).toBe(false);
  });

  it("shows sizes the way people read them", () => {
    expect([null, 0, 1023, 1024, 15_360, 5_242_880, 3 * 1024 ** 3].map(sizeLabel)).toEqual(["", "0 B", "1023 B", "1.0 KB", "15 KB", "5.0 MB", "3.0 GB"]);
  });

  const sheets: BrowserEditor = { id: "sheets", title: "Spreadsheet (GridCraft)", kind: "browser", program: "gridcraft", types: ["xlsx", "csv"], max_mb: 50, app: "drive-editors", version: "0.1.0" };
  const pdf: BrowserEditor = { ...sheets, id: "pdf", title: "PDF (PdfCraft)", program: "pdfcraft", types: ["pdf"], max_mb: undefined };
  const file = (name: string, size = 1000) => ({ id: "f1", name, size });

  it("offers the online editor first, then the browser editors for the type", () => {
    const both = { online: true, browser: [sheets, pdf] };
    expect(editorsFor(file("Budget.XLSX"), both).map((c) => c.key)).toEqual(["online", "sheets"]);
    expect(editorsFor(file("Budget.xlsx"), both)[1].to).toBe("/drive/edit/f1/sheets");
    expect(editorsFor(file("report.pdf"), both).map((c) => c.key)).toEqual(["pdf", "view"]);
    expect(editorsFor(file("budget.xlsx"), { online: false, browser: [sheets] }).map((c) => c.key)).toEqual(["sheets"]);
    expect(editorsFor(file("photo.png"), both).map((c) => c.key)).toEqual(["view"]);
    expect(editorsFor(file("README"), both)).toEqual([]);
  });

  it("puts editors that cannot take a file last, saying why", () => {
    const big = editorsFor(file("budget.xlsx", 60 * 1024 * 1024), { online: false, browser: [sheets] });
    expect(big).toEqual([{ key: "sheets", label: "Spreadsheet (GridCraft)", to: "/drive/edit/f1/sheets", unavailable: "larger than 50 MB" }]);
    expect(editorsFor(file("budget.xlsx", 60 * 1024 * 1024), { online: true, browser: [sheets] }).map((c) => c.key)).toEqual(["online", "sheets"]);
    expect(editorsFor(file("huge.pdf", 5e9), { online: false, browser: [pdf] })[0].unavailable).toBeUndefined();
  });

  it("opens with the first editor that can, and not a browser editor on a phone", () => {
    const sheet = editorsFor(file("budget.xlsx"), { online: false, browser: [sheets] });
    expect(defaultEditor(sheet, false)?.key).toBe("sheets");
    expect(defaultEditor(sheet, true)).toBeUndefined();
    expect(defaultEditor(editorsFor(file("budget.xlsx"), { online: true, browser: [sheets] }), true)?.key).toBe("online");
    expect(defaultEditor(editorsFor(file("budget.xlsx", 60 * 1024 * 1024), { online: false, browser: [sheets] }), false)).toBeUndefined();
  });

  it("reads extensions and names copies", () => {
    expect(["a.XLSX", "archive.tar.gz", "README", ".env"].map(extension)).toEqual(["xlsx", "gz", "", "env"]);
    expect(["budget.xlsx", "a.b.docx", "README", ".env"].map(copyName)).toEqual(["budget (copy).xlsx", "a.b (copy).docx", "README (copy)", ".env (copy)"]);
  });

  it("says why a file opened read-only", () => {
    expect(readOnlyReason({ held_by: "me@acme.test", held_in: "browser" }, "me@acme.test")).toBe("You are editing this file in another tab or window.");
    expect(readOnlyReason({ held_by: "ana@acme.test", held_in: "browser" }, "me@acme.test")).toBe("ana@acme.test is editing this file in a browser editor.");
    expect(readOnlyReason({ held_by: null, held_in: "online" }, "me@acme.test")).toBe("Someone is editing this file in the online editor.");
    expect(readOnlyReason({ held_by: "ana@acme.test", held_in: "checkout" }, "me@acme.test")).toBe("ana@acme.test has checked this file out.");
    expect(readOnlyReason({ held_by: null, held_in: null }, "me@acme.test")).toBe("You can view this file but not change it.");
  });

  it("says who has a file open", () => {
    expect(presenceLabel([])).toBe("");
    expect(presenceLabel([{ name: "Ana", mode: "edit" }])).toBe("Ana is editing");
    expect(presenceLabel([{ name: "Ana", mode: "view" }, { name: "Ben", mode: "view" }])).toBe("Ana and Ben are viewing");
    expect(presenceLabel([{ name: "Ana", mode: "edit" }, { name: "Ben", mode: "view" }, { name: "Cy", mode: "view" }])).toBe("Ana and 2 others are here, editing");
  });

  it("offers to join people editing together, not someone in a browser editor", () => {
    expect(joinable([{ name: "Ana", mode: "edit" }, { name: "Ben", mode: "view" }])).toBe(true);
    expect(joinable([{ name: "Ana", mode: "edit", editor: "browser" }, { name: "Ben", mode: "view" }])).toBe(false);
    expect(joinable([{ name: "Ben", mode: "view" }])).toBe(false);
    expect(joinable([])).toBe(false);
  });

  it("knows what each role may do, and its name", () => {
    expect(allows("Comment", "View") && allows("Comment", "Comment") && !allows("Comment", "Edit")).toBe(true);
    expect(allows("Manage", "Edit") && !allows("View", "Comment")).toBe(true);
    expect(["View", "Comment", "Edit", "Manage", "Other"].map(roleLabel)).toEqual(["Viewer", "Commenter", "Editor", "Manager", "Other"]);
  });

  it("opens live documents in Docs, or in Drive's viewer where Docs is not installed", () => {
    const live = { online: true, browser: [sheets] };
    expect(editorsFor(file("Plan.FDOC"), { ...live, docs: true })).toEqual([
      { key: "live", label: "Document editor", to: "/docs/d/f1", external: true },
      { key: "view", label: "Viewer", to: "/drive/view/f1" },
    ]);
    expect(editorsFor(file("Plan.fdoc"), { ...live, docs: false }).map((c) => c.key)).toEqual(["view"]);
    expect(defaultEditor(editorsFor(file("Plan.fdoc"), { ...live, docs: true }), true)?.to).toBe("/docs/d/f1");
    expect(defaultEditor(editorsFor(file("photo.png"), live), true)?.key).toBe("view");
  });
});
