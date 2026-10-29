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
