// The preview's answers for a file Drive cannot show as itself: never an empty tab.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileBody } from "./Preview";
import { retention } from "./Versions";

const draw = (name: string, o: { online?: boolean; admin?: boolean } = {}) =>
  renderToString(<FileBody id="f1" item={{ name, file_type: null }} online={!!o.online} admin={!!o.admin} down={() => {}} />).replace(/<!-- -->/g, "");

describe("the preview of a file with no way to show it", () => {
  it("says an office file needs an office editor, and who can turn one on", () => {
    const people = draw("Plan.docx");
    expect(people).toContain("This file needs an office editor to open");
    expect(people).toContain("administrator has not turned on");
    expect(people).toContain("Download");
    expect(people).not.toContain("/store/apps/drive/settings");
    expect(draw("Budget.xlsx", { admin: true })).toContain('href="/store/apps/drive/settings"');
    // With an online editor the file opens in its read-only view instead.
    expect(draw("Deck.pptx", { online: true })).not.toContain("needs an office editor");
  });
  it("says so for any other type, and offers the download", () => {
    const html = draw("bundle.zip");
    expect(html).toContain("No preview for this type");
    expect(html).toContain("Download");
  });
});

describe("what Drive says about old versions", () => {
  it("says how many are kept and what happens to the rest", () => {
    expect(retention(100, 12, false)).toContain("newest 100 versions");
    expect(retention(100, 12, false)).toContain("12 here");
    expect(retention(5, 5, false)).toContain("the oldest one is removed when the next is added");
    // A kept oldest version is not about to go.
    expect(retention(5, 5, true)).toContain("5 here");
    // An older server does not say how many: no number is claimed.
    expect(retention(undefined, 3, false)).not.toMatch(/\d/);
  });
});
