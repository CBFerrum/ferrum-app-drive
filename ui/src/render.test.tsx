// Drive's screens drawn once, on the server's side of React, from data the page would have fetched:
// they must draw without failing, say what they should, and keep their words for people.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { todayIso } from "@ferrum/client";
import { describe, expect, it } from "vitest";
import { BulkBar } from "./BulkBar";
import { BulkShareDialog } from "./BulkShare";
import { Chips } from "./Chips";
import { DrivePage } from "./Drive";
import type { Item } from "./files";
import { ShortcutsDialog } from "./KeysDialog";
import { MoveDialog } from "./MoveDialog";
import { NewTeamDialog, TeamDialog } from "./Teams";
import { ShareDialog } from "./Share";
import { readQuery } from "./listing";

const item = (id: string, name: string, extra: Partial<Item> = {}): Item => ({
  id,
  kind: "file",
  name,
  size: 2048,
  modified_at: "2026-11-01T10:00:00Z",
  modified_by: "ana@acme.test",
  permission: "Edit",
  locked_by: null,
  file_type: "Document",
  parent: "root",
  ...extra,
});
const folder = (id: string, name: string) => item(id, name, { kind: "folder", size: null, file_type: null });

const USAGE = {
  space: { id: "sp1", owner: "me@acme.test", root: "root", quota_bytes: 5 * 1024 ** 3, used_bytes: 4.4 * 1024 ** 3 },
  teams: [{ id: "eng", name: "Engineering", quota_bytes: 10 * 1024 ** 3, used_bytes: 2 * 1024 ** 3, permission: "Manage" }],
  admin: true,
  limits: { max_upload_bytes: 25 * 1024 ** 2, trash_days: 30 },
};

/** What a page asked for is kept under the key it would use; this is that key for a source. */
const listKey = (src: unknown, today: string | null = null) => ["drive", "list", JSON.stringify([src, [null, null, null, null, null], today])];

function draw(ui: React.ReactElement, location: string, seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(qc);
  // React separates the text nodes it draws side by side with a comment; people never see it.
  return renderToString(
    <QueryClientProvider client={qc}>
      <StaticRouter location={location}>{ui}</StaticRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, "");
}

const common = (qc: QueryClient) => {
  qc.setQueryData(["drive", "space"], { id: "sp1", root_folder: "root" });
  qc.setQueryData(["drive", "usage"], USAGE);
  qc.setQueryData(["people"], { users: [{ id: "u1", email: "ana@acme.test", full_name: "Ana Rao" }] });
};
const inRoot = (qc: QueryClient) => qc.setQueryData(["drive", "item", "root"], { ...folder("root", "My Folders"), parent: null, permission: "Manage", breadcrumbs: [{ id: "root", name: "My Folders" }] });
/** A first page of a list, as the page keeps it; more follow when the server counts more than it sent. */
const page = (qc: QueryClient, key: string[], items: Item[], total = items.length) =>
  qc.setQueryData(key, { pages: [{ items, offset: 0, total, next: total > items.length ? items.length : undefined }], pageParams: [0] });

describe("Drive's home", () => {
  const files = [folder("f1", "Reports"), item("d1", "plan.docx", { starred: true }), item("d2", "Launch notes.fdoc", { snippet: "Risks · The «venue» may move" })];

  it("lists a folder with its places, its chips and its actions", () => {
    const html = draw(<DrivePage />, "/drive", (qc) => {
      common(qc);
      inRoot(qc);
      page(qc, listKey({ kind: "folder", folder: "root" }), files);
    });
    expect(html).toContain("My files");
    for (const word of ["Shared with me", "Recent", "Starred", "Trash", "Team folders", "Engineering", "Your storage", "4.4 GB of 5.0 GB"]) expect(html, word).toContain(word);
    for (const word of ["Reports", "plan.docx", "Launch notes", "Sort: Name", "Type", "Modified", "Owner", "New", "Upload"]) expect(html, word).toContain(word);
    expect(html).not.toContain("Launch notes.fdoc");
    expect(html).toContain("Choose Reports");
    expect(html).toContain("Choose every item shown");
    expect(html).toContain("<mark>venue</mark>");
    expect(html).toContain('draggable="true"');
    // Near the limit, the storage says so and the meter turns amber.
    expect(html).toContain('data-tone="near"');
    expect(html).toContain("614 MB left");
  });

  it("says what an empty folder is for, and what it knows of how many there are", () => {
    const empty = draw(<DrivePage />, "/drive", (qc) => {
      common(qc);
      inRoot(qc);
      page(qc, listKey({ kind: "folder", folder: "root" }), []);
    });
    expect(empty).toContain("This folder is empty");
    expect(empty).toContain("Drop files here, or use Upload or New.");
    const long = draw(<DrivePage />, "/drive", (qc) => {
      common(qc);
      inRoot(qc);
      page(qc, listKey({ kind: "folder", folder: "root" }), files, 1340);
    });
    expect(long).toContain("Show more");
    expect(long).toContain("Showing 3 of 1,340");
  });

  it("draws the trash with what can be done there, and no way to add", () => {
    const html = draw(<DrivePage />, "/drive?view=trash", (qc) => {
      common(qc);
      page(qc, listKey({ kind: "trash" }), [item("t1", "old.txt", { trashed_at: "2026-10-30T10:00:00Z" })]);
    });
    expect(html).toContain("Empty the trash");
    expect(html).toContain("old.txt");
    expect(html).not.toContain(">Upload<");
    expect(html).not.toContain("Sort:");
  });

  it("draws the empty trash and an empty search in words a person would say", () => {
    const bin = draw(<DrivePage />, "/drive?view=trash", (qc) => {
      common(qc);
      page(qc, listKey({ kind: "trash" }), []);
    });
    expect(bin).toContain("The trash is empty");
    expect(bin).toContain("stays here for 30 days");
    const none = draw(<DrivePage />, "/drive?q=zebra", (qc) => {
      common(qc);
      page(qc, listKey({ kind: "search", query: "zebra" }, todayIso()), []);
    });
    expect(none).toContain("Search: zebra");
    expect(none).toContain("Nothing matches “zebra”");
    expect(none).toContain("Clear the search");
  });

  it("starts as a list on its way, not an empty folder", () => {
    const html = draw(<DrivePage />, "/drive", common);
    expect(html).toContain('aria-label="Loading…"');
    expect(html).not.toContain("This folder is empty");
  });
});

describe("what opens over the list", () => {
  it("lists the chosen items' actions, only those the person may do to all of them", () => {
    const actions = { move: () => {}, share: () => {}, download: () => {}, trash: () => {}, restore: () => {}, destroy: () => {}, clear: () => {} };
    const all = draw(<BulkBar chosen={[item("a", "a.txt"), item("b", "b.txt", { permission: "Manage" })]} trash={false} actions={actions} />, "/", () => {});
    expect(all).toContain("2 selected");
    expect(all).toContain("Clear selection");
    for (const word of ["Move to…", "Copy to…", "Download", "Move to trash"]) expect(all, word).toContain(word);
    expect(all).not.toContain("Share");
    const view = draw(<BulkBar chosen={[item("a", "a.txt", { permission: "View" })]} trash={false} actions={actions} />, "/", () => {});
    expect(view).not.toContain("Move to…");
    expect(view).not.toContain("Move to trash");
    expect(view).toContain("Copy to…");
    const bin = draw(<BulkBar chosen={[item("a", "a.txt", { permission: "Manage" })]} trash actions={actions} />, "/", () => {});
    expect(bin).toContain("Restore");
    expect(bin).toContain("Delete forever");
  });

  it("draws the chips a source offers", () => {
    const q = readQuery(new URLSearchParams("type=PDF&since=7"));
    const html = draw(<Chips src={{ kind: "folder", folder: "root" }} q={q} set={() => {}} />, "/", common);
    expect(html).toContain("Type: PDFs");
    expect(html).toContain("Modified: Last 7 days");
    expect(html).toContain("Clear filters");
    expect(draw(<Chips src={{ kind: "trash" }} q={q} set={() => {}} />, "/", common)).toBe("");
  });

  it("shows the keys", () => {
    const html = draw(<ShortcutsDialog onClose={() => {}} />, "/", () => {});
    for (const word of ["Keyboard shortcuts", "Move to…", "Choose every item shown", "Move to the trash"]) expect(html, word).toContain(word);
  });

  it("asks where items go, from the person's places", () => {
    const html = draw(<MoveDialog items={[item("d1", "plan.docx")]} copy={false} start={null} root="root" usage={USAGE} onChoose={() => {}} onClose={() => {}} />, "/", common);
    expect(html).toContain("Move “plan.docx” to…");
    for (const word of ["Places", "My files", "Engineering", "Move here"]) expect(html, word).toContain(word);
    expect(html).toContain("Open a folder to choose it.");
  });
});

describe("sharing and team folders", () => {
  const link = { id: "l1", access: "Download", has_password: true, expires_at: "2099-01-01T00:00:00Z", max_downloads: 5, download_count: 2, last_accessed_at: "2026-10-30T10:00:00Z", note: "For the audit" };

  it("shows who has access and why, the rules for links and the links made", () => {
    const html = draw(<ShareDialog item={{ id: "i1", name: "Plan.docx", kind: "file" }} space="sp1" onClose={() => {}} />, "/", (qc) => {
      common(qc);
      qc.setQueryData(["drive", "shares", "i1"], {
        owner: "me@acme.test",
        team: null,
        shares: [
          { id: "s1", email: "ana@acme.test", permission: "Edit", expires_at: "2099-01-01T00:00:00Z" },
          { id: "s2", email: "ben@acme.test", permission: "View", inherited_from: "f1" },
        ],
      });
      qc.setQueryData(["drive", "links", "i1"], { links: [link], policy: { allow_public_links: true, max_link_days: 7, link_password_required: true } });
      qc.setQueryData(["drive", "item", "i1"], { ...item("i1", "Plan.docx"), breadcrumbs: [{ id: "f1", name: "Reports" }] });
    });
    expect(html).toContain("Share “Plan.docx”");
    for (const word of ["Ana Rao", "Comes down from the folder", "Reports", "Links in this workspace need a password and end within 7 days.", "Required: at most 7 days", "Required: at least 8 characters", "For the audit", "2 of 5 uses", "Turn off", "Make a link"]) expect(html, word).toContain(word);
  });

  it("says plainly when links are off", () => {
    const html = draw(<ShareDialog item={{ id: "i1", name: "Plan.docx", kind: "file" }} space="sp1" onClose={() => {}} />, "/", (qc) => {
      common(qc);
      qc.setQueryData(["drive", "shares", "i1"], { owner: "me@acme.test", team: null, shares: [] });
      qc.setQueryData(["drive", "links", "i1"], { links: [], policy: { allow_public_links: false, max_link_days: 0, link_password_required: false } });
      qc.setQueryData(["drive", "item", "i1"], item("i1", "Plan.docx"));
    });
    expect(html).toContain("Public links are turned off for this workspace.");
    expect(html).not.toContain("Make a link");
  });

  it("shares several items with one person", () => {
    const html = draw(<BulkShareDialog items={[item("a", "a.txt"), item("b", "b.txt")]} space="sp1" onClose={() => {}} onDone={() => {}} />, "/", common);
    expect(html).toContain("Share 2 items");
    expect(html).toContain("a.txt, b.txt");
  });

  it("lists a team folder's members and its space, and lets an administrator set the limit", () => {
    const html = draw(<TeamDialog team="eng" space="sp1" onClose={() => {}} />, "/", (qc) => {
      common(qc);
      qc.setQueryData(["drive", "shares", "eng"], { owner: null, team: { id: "eng", name: "Engineering", members: [{ member: "ana@acme.test", role: "Manager" }] }, shares: [] });
    });
    for (const word of ["Team folder “Engineering”", "Members (1)", "Ana Rao", "Space limit (GB)", "2.0 GB of 10 GB", "Add people"]) expect(html, word).toContain(word);
  });

  it("makes a team folder", () => {
    const html = draw(<NewTeamDialog space="sp1" onClose={() => {}} onMade={() => {}} />, "/", common);
    expect(html).toContain("New team folder");
    expect(html).toContain("Make the team folder");
  });
});
