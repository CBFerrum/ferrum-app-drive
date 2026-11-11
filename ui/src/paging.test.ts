import { describe, expect, it } from "vitest";
import { readQuery } from "./listing";
import { PAGE, request } from "./useDrive";

const q = (query = "") => readQuery(new URLSearchParams(query));

describe("what a page of a list asks the server for", () => {
  it("asks a folder for a page at a time, not for more than the server gives", () => {
    expect(PAGE).toBeLessThanOrEqual(200);
    expect(request({ kind: "folder", folder: "f1" }, q(), "2026-11-10")).toEqual(["list_folder", { folder: "f1", sort: undefined, order: undefined, limit: PAGE }]);
  });

  it("sorts a folder in the direction that reads most naturally unless told otherwise", () => {
    expect(request({ kind: "folder", folder: "f1" }, q("sort=modified"), "2026-11-10")[1]).toMatchObject({ sort: "modified", order: "desc" });
    expect(request({ kind: "folder", folder: "f1" }, q("sort=modified&order=asc"), "2026-11-10")[1]).toMatchObject({ sort: "modified", order: "asc" });
    expect(request({ kind: "folder", folder: "f1" }, q("sort=name"), "2026-11-10")[1]).toMatchObject({ sort: "name", order: "asc" });
  });

  it("asks a search for what the chips say, a page at a time", () => {
    expect(request({ kind: "search", query: "plan" }, q("type=PDF&since=7&owner=ana@acme.test"), "2026-11-10")).toEqual([
      "search",
      { query: "plan", type: "PDF", folder: undefined, owner: "ana@acme.test", modified_from: "2026-11-04", sort: undefined, limit: PAGE },
    ]);
  });

  it("asks the trash a page at a time, and the other views for everything", () => {
    expect(request({ kind: "trash" }, q(), "2026-11-10")).toEqual(["list_trash", { limit: PAGE }]);
    expect(request({ kind: "view", view: "shared" }, q(), "2026-11-10")).toEqual(["shared_with_me", {}]);
    expect(request({ kind: "view", view: "recent" }, q(), "2026-11-10")).toEqual(["recent", { limit: 100 }]);
    expect(request({ kind: "view", view: "starred" }, q(), "2026-11-10")).toEqual(["starred", {}]);
  });
});
