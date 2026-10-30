# Changelog

## 0.4.1

- Working together (Ferrum docs/plan/collaboration.md, C1).
  * Comments can mention people (`mentions`, emails). Those who may see the file are told in the
    bell and by mail, and the file's owner hears of comments by others.
  * Open pages report who has a file open, viewing or editing (`POST presence/<file>`). Anyone who
    may see the file sees who did so in the last 90 seconds (`GET presence?files=`).
  * `request_access` asks an item's owner, or a team folder's managers, to share it. A request
    counts once a day, and the answer never says whether the item exists.

## 0.4.0

- Browser editors (Ferrum docs/plan/browser-editors.md). Drive offers the extension point
  `drive.editor`, and its add-on Browser editors (`drive-editors`, shipped with Drive) contributes
  GridCraft (xlsx, csv, tsv), WordCraft (docx, odt, rtf) and PdfCraft (pdf). They run in the
  browser from the operator's editor server (`FERRUM_EDITORS_URL`); each save is a new version,
  made with the person's rights.
- One editor lock per file, shared by browser and online editor sessions, now records who holds
  it. While a session holds a file, others open it read-only and are told who is editing.
- Uploads, restores and check-ins no longer overwrite a file that an editor session holds. They
  are refused until it closes; before, the next online save turned such a version into an old one.
- Saves can carry the version they were made from (`base`): a file that changed since it was
  opened is not overwritten.

## 0.3.0

- Large files. Uploads, new versions and the editor's saves take files up to the operator's
  `FERRUM_DRIVE_MAX_FILE_MB` (32 MB unless set, at most 1 GiB). The workspace's Largest Upload
  goes up to 1024 MB, and the operator's limit caps it. Drive's other routes accept at most 1 MB
  each. The server reads no request body past its route's limit (Ferrum 0.3 with per-route body
  reading).

## 0.2.1

- WOPI proof keys: when the editor server publishes a proof key, every WOPI call must carry a valid
  proof signature over its token, URL and time (current or previous key, at most 20 minutes old).
  Unsigned calls are refused. Checked against Collabora Online 26.04 with a mounted key.

## 0.2.0

- Online editing: an editor server the operator runs (Collabora Online, or ONLYOFFICE Docs in WOPI
  mode, set with `FERRUM_OFFICE_URL` and `FERRUM_OFFICE_WOPI_URL`) opens Drive files with the
  person's own rights and saves every change as a new version. `POST /editor/{file}` returns the
  editor page and a token bound to the workspace, the file, the person and ten hours. The WOPI
  endpoints (`/api/site/{tenant}/drive/wopi/files/{file}`) lock the file while it is open, accept
  saves only from the session holding the lock, and can be limited to the editor's addresses
  (`FERRUM_OFFICE_IPS`). `POST /new?kind=docx|xlsx|pptx|odt|ods|odp` makes a blank document for
  the editor to fill.

## 0.1.0

- First release. Drive gives every person a space and teams shared folders with members and quotas.
  Uploads are typed from their bytes and hashed, keep every version (restorable, with a workspace
  limit) and can be checked out. Items are shared with people or roles at View, Comment, Edit or
  Manage, inherited down folders, optionally until a date, and published as public links with
  expiry, passwords and download limits. Move, copy, trash, restore, delete for good and a trash
  purge job complete the file system; search, recent, starred, shared-with-me, comments, an
  activity log and storage reports sit on top. Folders and files are invisible to the generic API
  for everyone but Drive administrators: people use actions on their own Drive Space (also over
  MCP) and the Site endpoints, which check every item against Drive's sharing rules.
