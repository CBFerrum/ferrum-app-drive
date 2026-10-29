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

Tokens last ten hours and are bound to the workspace, the file and the person. Locks lapse 30
minutes after their last refresh. A file is saved only by the session holding its lock, and an
empty file can be filled without one.

When the editor publishes a proof key in its discovery, every WOPI call must carry a valid proof
signature (current or previous key, at most 20 minutes old), so a token alone opens nothing. The
stock Collabora image publishes no key until one is mounted, and Collabora can make one:
`ssh-keygen -t rsa -N "" -m PEM -f proof_key`, mounted at `/etc/coolwsd/proof_key`. Without a key,
keep the WOPI endpoints to the editor with `FERRUM_OFFICE_IPS` or network policy. Saves are limited
by Drive's upload limit (at most 32 MB).

`POST /api/app/drive/new?kind=docx|xlsx|pptx|odt|ods|odp&folder=<id>` makes a blank file for the
editor to fill. `POST /api/app/drive/editor/<file>` returns the editor page and the token to post
to it.

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
