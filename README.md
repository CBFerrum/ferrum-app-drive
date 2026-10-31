# Ferrum Drive

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- Personal spaces and team folders with members (Viewer, Commenter, Editor, Manager), folder colours, breadcrumbs, sorting and paging
- Uploads with content types detected from the bytes, SHA-256 hashes, name clashes kept as `name (2)`, a workspace upload limit and per-person and per-team quotas that hold under concurrent uploads
- Version history with comments, restore as a new version and a version limit; check-out and check-in so nobody overwrites a file someone is editing
- Sharing with people or roles at View, Comment, Edit or Manage, inherited by everything inside a folder, optionally until a date; revocation and role changes apply to the next request
- Public links for files and folders: View (browse and preview) or Download, expiry, Argon2id passwords with lockout, download limits counted atomically, revocable; unknown, expired and forbidden links all look the same
- Move (cycles refused), copy, trash, restore and delete for good with every stored version; trash purged after a set number of days
- Search by name, type, owner, modification date and folder; recent, starred and shared-with-me lists; comments; an activity log of every change, download and public access
- Images and PDFs open inline; everything else downloads, and anything a browser could run is served as opaque bytes
- Reports: storage by person, team folder and file type, largest files, public links
- Folders, files and their records never reach the generic API, search, exports or MCP for anyone but Drive administrators: people work through actions on their own Drive Space, each checked against Drive's sharing rules
- `packages/drive/README.md` documents every entity, action, endpoint, setting and upkeep job

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `drive` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

## Online editing

Documents, spreadsheets and presentations open in an editor server that the operator runs:
Collabora Online, or ONLYOFFICE Docs in WOPI mode. The editor reads and saves files over WOPI, with
the person's own Drive rights. Every save becomes a new version: autosaves, explicit saves and the
save when the last person leaves.

* `FERRUM_OFFICE_URL`: the editor server as Ferrum reaches it. Ferrum reads
  `<url>/hosting/discovery`, and private addresses are allowed.
* `FERRUM_OFFICE_WOPI_URL`: Ferrum as the editor server reaches it. It becomes
  `WOPISrc=<url>/api/site/<workspace>/drive/wopi/files/<file>`.
* `FERRUM_OFFICE_IPS` (optional): the only addresses WOPI calls are accepted from.
* The web app's `FERRUM_OFFICE_ORIGIN`: the editor's origin, which the app may frame and post to.

Collabora needs to know Ferrum and the web app:
* `aliasgroup1=<FERRUM_OFFICE_WOPI_URL>` lets Ferrum be its WOPI host.
* `--o:net.frame_ancestors=<web app origin>` lets the app frame it.

The editor and the web app talk (WOPI's PostMessage API; Ferrum docs/plan/collaboration.md, C2).
CheckFileInfo names the web app's origin, from the server's `PUBLIC_URL`, as `PostMessageOrigin`.
* The editor says who is in the file (Collabora's `Views_List`, or `View_Added` and `View_Removed`
  in older versions), and the page shows them.
* Its Share button (for people with Manage access: `EnableShare`, `FileSharingPostMessage`) opens
  Drive's sharing.
* Its version history (`FileVersionPostMessage`) opens Drive's versions.
* Its close button (`ClosePostMessage`) goes back.
* The page shows whether the file has unsaved changes (`Doc_ModifiedStatus`).

Collabora shows the close and version history buttons only when its page is opened with
`closebutton=1` and `revisionhistory=1`, which Drive adds to its address. Without `PUBLIC_URL`, the
editor keeps its own buttons.

Tokens last ten hours and are bound to the workspace, the file and the person. Locks lapse 30
minutes after their last refresh. A file is saved only by the session holding its lock, and an
empty file can be filled without one.

When the editor publishes a proof key in its discovery, every WOPI call must carry a valid proof
signature (current or previous key, at most 20 minutes old), so a token alone opens nothing. The
stock Collabora image publishes no key until one is mounted, and Collabora can make one:
`ssh-keygen -t rsa -N "" -m PEM -f proof_key`, mounted at `/etc/coolwsd/proof_key`. Without a key,
keep the WOPI endpoints to the editor with `FERRUM_OFFICE_IPS` or network policy. Saves are limited
by Drive's upload limit.


`POST /api/app/drive/new?kind=docx|xlsx|pptx|odt|ods|odp&folder=<id>` makes a blank file for the
editor to fill. `POST /api/app/drive/editor/<file>` returns the editor page and the token to post
to it.

## Browser editors

With the add-on **Browser editors** (`drive-editors`, shipped with Drive) installed in a workspace,
spreadsheets, documents and PDFs also open in editors that run in the person's browser:
* GridCraft for xlsx, csv and tsv;
* WordCraft for docx, odt and rtf;
* PdfCraft for pdf.

The operator serves the editors' official builds from the editor server (Ferrum's
`deploy/editors`), on an origin of its own, and sets `FERRUM_EDITORS_URL` (the editor server as
browsers reach it) on the server and the web app. The web app downloads the file, hands it to the
editor through the editor server's relay page, and saves what the editor returns as a new version,
with the person's rights. Files are never sent to the editor server.

**One session at a time.**
* Browser and online editor sessions share the file's lock: 30 minutes, refreshed while the
  editor is open.
* While a session holds the lock, others open the file read-only and are told who is editing.
* Every other save is refused meanwhile: uploads, restores, the online editor.

**Conflicts.** Saves carry the version they were made from, so a file changed since it was opened
is never overwritten. The person saves a copy or replaces it.

**API.**
* `POST /api/app/drive/editor/<file>?kind=browser` (`action=view`, `take_over`) starts a session:
  `{url, lock, version, action, held_by, held_in, …}`.
* `POST /api/app/drive/editor/<file>/lock?lock=…&op=refresh|release` keeps or ends it.
* `GET /api/app/drive/editors` says which kinds of editor the server runs: `{online, browser}`.
* A save is `POST /api/app/drive/files/<file>/versions?lock=…&base=<version>`.

**More editors.** Other add-ons can offer editors on Drive's extension point `drive.editor`, with
`title`, `kind: browser`, `program` (a directory of the editor server), `types` and `max_mb`.

## Working together

* **Comments** can mention people: `add_comment` with `mentions` (emails). Those who may see the
  file are told in the bell and by mail, and the file's owner hears of comments by others.
  * On a live document's text: `anchor` (`{from, to}`, Yjs relative positions; the Docs editor makes
    them) and `quote` (the words as they read). The place moves with everyone's typing.
  * In threads: `reply_to` names the comment starting the thread (on the same file); its author
    hears of replies. Deleting that comment deletes its replies.
  * `resolve_comment` with `comment` and `resolved` (true, or false to reopen), by anyone who may
    comment: `list_comments` then says `resolved_by` and `resolved_at`, and the editor stops marking
    its text.
* **Presence.**
  * Open pages report who has a file open: `POST /api/app/drive/presence/<file>?mode=view|edit|gone`,
    every 30 seconds.
  * Anyone who may see a file sees who reported in the last 90 seconds, in the answer or with
    `GET /api/app/drive/presence?files=<id>,…`.
  * Someone editing a file a browser editor holds is marked `"editor": "browser"`: that editor is
    one person's at a time, so the web app offers to join only people in the online editor or a
    live document.
* **Requests for access.** `request_access` with `item` and an optional `message` tells the item's
  owner, or a team folder's managers. A request counts once a day per item and person. The answer
  is the same whether or not the item exists, so it reveals nothing.
* **Images in documents.** `POST /api/app/drive/files/<document>/images` with the image as the body
  (PNG, JPEG, GIF or WebP, up to 10 MB and 20,000 pixels a side; Edit) answers
  `{id, width, height, content_type, size}`; the document names the image by `id`, and
  `GET /api/app/drive/files/<document>/images/<id>` shows it to anyone who may view the document.
  Each document keeps its own images: its space pays for them, they go when it is deleted for good,
  and a copy (or a version restored as one) gets copies. An image pasted from another document shows
  to those who may view that one until the next save gives this document its own copy.
* **Downloads of documents** (`GET /api/app/drive/files/<document>/content?format=`): `html` and
  `pdf` carry their images inside, `docx` is a Word file (images, lists, tables, links, and
  suggestions as tracked changes), `txt` the words. Public links with Download access offer the same.

## File size

A file travels in one request: an upload, a new version or an editor save. How large it may be
is set in two places:
* **`FERRUM_DRIVE_MAX_FILE_MB`** (server, default 32, at most 1024) is the largest the server
  accepts. Each replica holds a file in memory while storing it, so size replicas for the
  uploads that may run at once.
* **Largest Upload** (Drive Settings, at most 1024 MB) is the workspace's own limit, within the
  server's.

Behind the web app's proxy, also raise its `FERRUM_MAX_UPLOAD` (e.g. `200m`). A request must also
arrive within the server's `FERRUM_REQUEST_TIMEOUT_MS` (2 minutes unless raised), so for large
files over slow links raise that too. Other Drive routes take at most 1 MB.

## Its interface

Drive's interface (`ui/`) is served by Ferrum under its bar at `/drive/`, with Sheets, Slides and PDF
(Drive's files of one kind) at `/sheets/`, `/slides/` and `/pdf/`, and it heads the Workspace family
that Docs joins (Ferrum docs/plan/apps-ui.md). Shared links open on its public page
`/drive/s/{workspace}/{link}`. For other apps it picks files (`pick file`), shows them (`preview
file`), shares them (`share file`) and shows a file's comments and history beside their page (the
`details` panel). Uploads go through the shell, which carries on with them in other pages; an upload
sent with an `Idempotency-Key` is stored once.

`ui/dist` is committed: the crate embeds it, so the server carries the interface of the version it was
built with. With Ferrum-Frontend checked out at `../ferrum/web`:

```
cd ui
npm run build       # into dist/, stamped with its sources (commit dist/)
npm run check       # CI: dist/ was built from ui/ as it is
npm run typecheck && npm test
```

## Develop

Clone it next to the platform and point the platform dependencies at your checkout (this file
is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
ferrum-domain = { path = "../ferrum/crates/domain" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_drive_test
```

```bash
cargo test
```

`FERRUM_DRIVE_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

## License

AGPL-3.0-only, like the platform.
