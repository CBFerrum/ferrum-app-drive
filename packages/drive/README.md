# Drive package (`drive`)

Personal spaces, team folders, files with versions, sharing, public links, trash, quotas, search
and reports. Depends on `core`. Dates without a time (`modified_from`, `expires_at` given as
`YYYY-MM-DD`) are read in the workspace's time zone; instants are RFC 3339 UTC.

## Access model

A person's level on an item — **View** (open, download), **Comment** (also comment), **Edit** (also
upload, rename, move within the same space or team folder, trash, restore, check out) or **Manage**
(also share, publish links, delete for good, move to another space or team folder, break a
check-out) — is the highest of:

- their own space: Manage on everything in it;
- team folders they are a member of: Viewer, Commenter, Editor or Manager on everything inside;
- unexpired shares to them (by email) or to a role they hold, on the item or any folder above it.

Drive administrators — workspace administrators and roles that may read every Drive File through
the generic API (the **Drive Administrator** role) — manage everything.

Every item stores its enclosing folders (`ancestors`) and top folder (`root`), so levels are
computed per item and every list filters with one predicate built from the same grants. Access is
evaluated on every request: removing a share, an expiry passing or a role being taken away applies
to the next request.

**Nothing leaks through the platform.** Drive Folder, File, File Version, Share, Link, Activity,
Comment and Star records are readable through the generic records API (lists, search, exports,
link filters, titles, comments, tags, attachments, audit trails, MCP `search_records` /
`get_record`) by Drive administrators only, and nobody writes them there: every change goes
through Drive's actions (direct inserts, edits, imports and deletes are refused, administrators
included). Stored bytes are platform files attached to their Drive File and owned by no user, so
`/files/{id}` and the attachments API apply the same administrator-only rule and nobody can delete
a version's bytes behind Drive's back. Items a person may not see — missing ones, other people's,
trashed ones — all answer **404 `Drive item not found`**; visible items with too low a level answer
**403**. Breadcrumbs, paths, share lists and team member lists never name a folder above the first
one the person may see.

## Roles

| Role | Can |
|---|---|
| Drive User | read and create their own **Drive Space** (`if_owner`), read **Drive Settings**; everything else through actions on their space |
| Drive Administrator | Drive Settings; read, create and change every Drive Space (quotas); read and export every folder, file, version, share, link, activity and comment; create team folders, set their quotas, trash them; run the reports; Manage on every item |

## Entities

| Entity | Kind | Holds |
|---|---|---|
| **DriveSettings** | settings | `max_upload_mb` (1–1024, default 25; the server's `FERRUM_DRIVE_MAX_FILE_MB` caps it), `user_quota_mb` (default 5120; 0 = unlimited), `team_quota_mb` (default 51200), `trash_days` (default 30), `max_versions` (default 100; 0 = all), `allow_public_links` (default on), `max_link_days` (0 = links may never expire), `link_password_required` |
| **DriveSpace** | master | `owner` (email, unique), `full_name`, `quota_mb` (0 = unlimited), `used_bytes`, `root_folder` ("My Folders"). The anchor of every Drive action. Spaces cannot be deleted |
| **DriveFolder** | master | `name`, `parent`, `root`, `ancestors`, `is_team`, `owner` (personal trees; empty in team folders), `members` (**DriveTeamMember**: `member` email, `role` Viewer/Commenter/Editor/Manager — team folders), `quota_mb`, `used_bytes` (team folders), `colour`, `trashed`, `trashed_at`, `trashed_by` |
| **DriveFile** | master | `name` (unique per folder ignoring case, among items out of the trash), `folder`, `root`, `ancestors`, `owner`, `file_type`, `content_type` (from the bytes), `size`, `sha256`, `version_no`, `current_version`, `modified_at`, `modified_by`, `locked_by`, `locked_at` (check-out), `trashed`, `trashed_at`, `trashed_by` |
| **DriveFileVersion** | master | `file`, `version_no`, `stored_file` (the platform file), `size`, `sha256`, `content_type`, `author`, `comment` |
| **DriveShare** | master | `file` or `folder`; `email` or `role`; `permission` View/Comment/Edit/Manage; `expires_at`; `shared_by` |
| **DriveLink** | master | `file` or `folder`, `access` View/Download, `token_hash` (SHA-256), `password_hash` (Argon2id), `has_password`, `expires_at`, `max_downloads`, `download_count`, `revoked`, `revoked_at`, `revoked_by`, `shared_by`, `last_accessed_at` (hashes are hidden from everyone but workspace administrators) |
| **DriveActivity** | master | `file` / `folder`, `item_name`, `action`, `actor` (empty for public-link visitors and upkeep), `details` |
| **DriveComment** | master | `file`, `author`, `body` (≤ 4000 characters) |
| **DriveStar** | master | `email`, `file` / `folder` |

Quotas count every version of every file, trash included: a personal space pays for the items in
it (whoever uploaded them), a team folder for the items in it. Moving between spaces and team
folders moves the bytes with the item.

## Actions

Every operation is a document action on the caller's own Drive Space:
`POST /api/v1/DriveSpace/{space}/actions/{action}` with the parameters as the JSON body (MCP:
`run_action` with `entity: "DriveSpace"`). Find your space with `GET /api/v1/DriveSpace` (or
`search_records`); create it with an empty `POST /api/v1/DriveSpace` if you have none (opening
Drive through `GET /api/app/drive/space` does that too). The read-only actions are also
`GET /api/app/drive/{action}?…` with the same parameters.

**Item** (as returned): `{id, kind: "folder"|"file", name, parent, team (top folder id in team
folders), is_team, owner, size, content_type, file_type, version, sha256, modified_at,
modified_by, created_at, colour, locked_by, locked_at, trashed, trashed_at, permission, starred}`.
`limit`/`offset` page lists (offset ≤ 100000).

### Reading

| Action | Parameters → result |
|---|---|
| `list_folder` | `folder?` (default: your top folder), `sort?` name/modified/size/type, `order?` asc/desc, `limit?` (≤ 200, 50), `offset?` → `{folder, breadcrumbs: [{id, name}], items, total, folders, files}`; sub-folders first |
| `search` | `query?` (name contains, ≤ 100 characters), `type?` (`folder` or a file type), `owner?`, `modified_from?`, `modified_to?`, `folder?` (within), `sort?` modified/name/size, `limit?`, `offset?` → `{items (each with path), has_more}`; nothing in the trash; at least one criterion |
| `recent` | `limit?` (≤ 100, 20) → files you uploaded, changed or opened in the last 90 days that you can still see |
| `starred` | → your starred items you can still see |
| `shared_with_me` | → items shared with you or your roles (not your own), with `shared_by`, `share_expires_at` |
| `list_trash` | `root?` (a top folder) → `{items, total}`: what was trashed itself and you may restore (Edit) |
| `usage` | → `{space: {id, owner, root, quota_bytes, used_bytes}, teams: [{id, name, quota_bytes, used_bytes, permission}]}` (quota null = unlimited) |
| `item_info` | `item` → Item with `breadcrumbs`, `path`; files: `versions`, `comments`; folders: `folders`, `files` |
| `list_versions` | `file` → `{versions: [{id, version, size, sha256, content_type, author, comment, created_at, current}]}`, newest first |
| `download` | `file`, `version?` → `{name, version, content_type, size, sha256, content_base64, text}` (`text` for text files); up to 5 MB — larger files through `GET /files/{id}/content` |
| `list_shares` | `item` → `{owner, team: {id, name, members} \| null, shares: [{id, email, role, permission, expires_at, shared_by, created_at, inherited_from}]}` |
| `list_links` | `item` (Manage) → `{links: [{id, access, has_password, expires_at, max_downloads, download_count, revoked, shared_by, created_at, last_accessed_at, active}]}` — tokens are never shown again |
| `activity` | `item`, `limit?` (≤ 200, 50) → `{activity: [{id, at, action, item_name, actor, file, folder, details}]}`; for a folder, everything inside it too |
| `list_comments` | `file` → `{comments: [{id, author, body, created_at, mine}]}` |

### Changing

| Action | Parameters → result (level needed) |
|---|---|
| `upload` | `name`, `content_base64` (standard or URL-safe, padding optional) or `text`, `folder?`, `on_conflict?` keep_both (default: `name (2)`) / replace (new version of the same-named file) / fail, `comment?` → Item (Edit on the folder) |
| `upload_version` | `file`, `content_base64` or `text`, `comment?` → Item (Edit; refused while someone else has it checked out, and for live documents) |
| `create_folder` | `name`, `parent?`, `colour?`, `on_conflict?` keep_both/fail → Item (Edit) |
| `create_team_folder` | `name` (unique among team folders), `members?: [{member, role}]`, `quota_mb?`, `colour?` → `{folder, members}` (Drive administrators) |
| `add_team_member` / `remove_team_member` | `folder`, `member`, `role?` → `{folder, members}` (Manage on the team folder) |
| `set_team_quota` | `folder`, `quota_mb` → `{folder, quota_mb}` (Drive administrators) |
| `rename` | `item`, `name` → Item (Edit; team folders Manage); a taken name is **409** |
| `set_colour` | `folder`, `colour?` (`#abc` / `#aabbcc`; empty clears) → Item (Edit) |
| `move` | `item`, `to` (a folder) → Item (Edit on both; Manage on the item when `to` is in another space or team folder). Cycles, top folders and depth beyond 64 are **422**, a taken name **409** |
| `copy` | `item`, `to`, `name?` → the copy (View on the item, Edit on `to`): current versions (live documents as their editors left them), nothing in the trash, at most 1000 items and 1 GB; names avoid clashes |
| `trash` | `item` → Item (Edit; team folders: administrators; never your top folder) |
| `restore` | `item` → Item (Edit): back in place, renamed `name (2)` on a clash; items inside a trashed folder come back with it |
| `delete_forever` | `item` (in the trash) → `{deleted, freed_bytes}` (Manage): everything inside, every version, its stored files, shares, links, stars and comments |
| `empty_trash` | `root?` → `{deleted, freed_bytes, more}` (Manage; 200 items per call) |
| `check_out` | `file` → Item (Edit; not live documents) |
| `check_in` | `file`, `content_base64`/`text?` (a last version), `comment?`, `force?` → Item (the holder; Manage with `force` breaks someone else's check-out) |
| `restore_version` | `file`, `version` → Item (Edit): the old content becomes the newest version; for a live document, a new document beside it, `Name (version N).fdoc` |
| `share` | `item`, `email` or `role`, `permission?` (View), `expires_at?` → `{id, item, email, role, permission, expires_at}` (Manage); sharing again replaces the grant; the person is notified in the app and, with the Mail app, by email (the email names no item). An email outside the workspace (a guest): see below |
| `unshare` | `item`, `share?` / `email?` / `role?` → `{removed}` (Manage; anyone may remove their own share) |
| `create_link` | `item`, `access?` View/Download, `expires_at?`, `password?` (8–256 characters), `max_downloads?` → `{id, item, token, url, page, access, expires_at, has_password, max_downloads}` (Manage; within the workspace's link policy). `page` (`/app/s/{tenant}/{token}`) is the web app's page for the link; `url` its API |
| `revoke_link` | `link` → `{link, revoked}` (Manage on its item, even in the trash) |
| `star` / `unstar` | `item` → `{item, starred}` (View) |
| `add_comment` | `file`, `body` → `{id, file, author, body}` (Comment) |
| `delete_comment` | `comment` → `{deleted}` (its author, or Manage) |

Errors: `not_found` (404 — missing, invisible and trashed alike), `forbidden` (403 — level too
low), `conflict` (409 — a taken name, a checked-out file, a team name), `validation_failed` (422 —
parameters, e.g. upload size), `invalid` (422 — cycles, top folders, depth, and
`storage quota exceeded: … uses X of Y MB and this needs Z more`).

## Endpoints

### Signed in — `/api/app/drive/…` (Drive users)

| Method & path | Request → response |
|---|---|
| `GET /space` | → `{id, owner, root_folder}`; creates your space on first use |
| `GET /{action}` | a read action above, parameters as query → its JSON |
| `POST /upload` | query `name`, `folder?`, `on_conflict?`, `comment?`; body: the raw bytes (≤ the workspace limit, within the server's `FERRUM_DRIVE_MAX_FILE_MB`) → `201` Item |
| `POST /files/{id}/versions` | query `comment?`, `check_in=1?`; body: raw bytes → `201` Item |
| `POST /new` | query `kind` (`fdoc`, `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`), `name?` (Untitled), `folder?` → `201` Item: an empty file for its editor |
| `GET /files/{id}/content` | query `version?`, `inline=1?` → the bytes. `inline` applies to PNG, JPEG, GIF, WebP, BMP, AVIF and PDF; everything else is `attachment`, and HTML, SVG, XML and JavaScript are sent as `application/octet-stream`. Headers: `Content-Disposition` (UTF-8 name), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: … sandbox`, `Cache-Control: private, no-store`, `ETag` (SHA-256), `X-Drive-Version` |

Uploads are checked (name, access, size, quota) before any bytes are stored, stored holding no
database transaction, then committed under the folder's lock; a refused commit discards the bytes.

**Live documents** (`.fdoc`, type `application/vnd.ferrum.doc`, file type Document) are edited by
everyone who has them open at once, in the web app's editor (`/app/doc/{id}`), over the platform's
`/ws/docs/drive/{id}` (Ferrum's docs/plan/collaboration.md, C3). View and Comment access read one,
Edit and Manage change it; in the trash nobody opens it. The platform keeps the content while it is
edited and hands it back as a new version when its editors leave, or every ten minutes while they
type (author: the first of them; comment `Edited live` or `Edited live by N people`); content that
did not change adds no version. Its content is never replaced around the editor: new versions,
uploads that replace it and check-out are refused, and restoring a version makes a new document
beside it. Copies, downloads and the `download` action take the content as its editors left it,
not the last version. `GET /files/{id}/content?format=html|pdf|txt` exports it (a page that runs
nothing; a PDF through the server's PDF renderer; its words), also of a `version`; the `download`
action answers its words as `text`. Deleting one for good also deletes its live content.

**Guests.** Sharing with an email that is no user of the workspace makes a Download link for that
person alone (`email` on the link) and mails it to them: `{id, item, email, guest: true, permission:
"View", expires_at, mailed, page}`. The link page's address is built from the server's public
address (`PUBLIC_URL`); without the Mail app nothing is mailed and `page` carries the address to
send. It follows the workspace's link rules: refused while public links are off or need a password,
ending within `max_link_days` (by default at that limit). Guests can only be Viewers. Sharing with the
same person again revokes their previous link. A deactivated colleague's address is refused, not
made a guest. `list_links` shows each link's `email`; `revoke_link` removes a guest.

### Public — `/api/site/{tenant}/drive/…` (no sign-in)

| Method & path | Request → response |
|---|---|
| `GET /links/{token}` | query `folder?` (a folder inside a shared folder), `limit?` (≤ 200, 100), `offset?`; password-protected links need a grant (`X-Drive-Grant` header or `grant` query) → `{link: {access, expires_at, downloads_left, has_password}, item, folder?, breadcrumbs?, items?}` (names, sizes, types and dates only) |
| `POST /links/{token}/unlock` | `{password}` → `{grant, expires_at}` (one hour). Ten wrong passwords lock the link for 15 minutes (`429`) |
| `GET /links/{token}/content` | query `file?` (a file inside a shared folder), `inline=1?`, grant → the current version's bytes. View links serve only inline previews of images and PDFs; each delivery counts against `max_downloads`, claimed atomically. A live document is shown as a page (`inline=1`, any link) and downloads as `format=html`, `pdf` or `txt` (Download links; html unless asked) |

Unknown, malformed, revoked, expired and used-up tokens, trashed or deleted items, items outside the
shared folder, View links asked for a download and links while the workspace turned them off all
answer the same **404 `link not found`**; only a valid link without its password answers `401`.
Responses carry `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow` and
`Referrer-Policy: no-referrer`; the server rate-limits every public address.

## Reports (Drive administrators)

`drive_storage_by_user`, `drive_storage_by_team` (quota, used, used %, files, all-version and trash
bytes), `drive_storage_by_type`, `drive_largest_files` (`limit` 50/100/500, `include_trash`),
`drive_shared_externally` (public links; `status` Active/All).

## Upkeep (every minute)

- Items in the trash longer than `trash_days` are deleted for good (50 per run, each in its own
  transaction, re-checked under lock, logged without an actor).
- Expired shares are removed (they grant nothing already) and noted in the item's activity.

## Known limits

- Deleting versions removes their platform file records, so no API can reach the bytes, but the
  platform gives apps no way to delete objects from its file store yet: the bytes stay in storage
  (their keys are logged) until it does.
- One upload is one request, held in memory while it is stored: at most the server's
  `FERRUM_DRIVE_MAX_FILE_MB` (32 MB unless raised, at most 1 GiB). `content_base64` through the
  generic API or MCP is also bound by that API's JSON body limit; use `POST /api/app/drive/upload`
  for large files. Drive's other routes take at most 1 MB.
- Public links stay valid when the person who created them loses access (as in other drives):
  review an item's links with `list_links`.
- Role shares notify nobody; email notifications need the Mail app.
