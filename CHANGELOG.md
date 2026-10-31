# Changelog

## 0.9.0

- Images in documents edited live (Ferrum collaboration.md, C3): uploaded to the document
  (`POST /files/<document>/images`, Edit), shown to whoever may view it, kept and paid for by the
  document, copied with its copies and restored versions, and adopted by a document they are pasted
  into at its next save (when the editor saving it may view them). Deleting a document for good
  refunds its images; moving it moves their usage.
- Documents download as Word files (`format=docx`): headings, lists, checklists, tables with merged
  cells, links, images and suggestions as tracked changes. Pages and PDFs carry their images; public
  links' pages show them.

## 0.8.1

- The list is drawn with the suite's components: each item shows what it is (a folder, a document, a
  spreadsheet, a presentation, a PDF, an image, a video, a sound, an archive) in its kind's colour
  beside its name, and one menu per row holds opening, Open with, details, sharing, the star,
  renaming, downloading and the trash. Join stays on the row while others edit the file.
- Documents edited live show their names without `.fdoc`; renaming one keeps it a live document.
- The New menu and Upload have icons; the folder path shows under the title only inside a folder.
- The file picker (the `pick file` intent) shows each file's kind, and its list starts right under
  the search field.

## 0.8.0

- Drive's own interface (Ferrum docs/plan/apps-ui.md, U4a), out of the web app: `ui/`, at `/drive/`
  with Sheets, Slides and PDF (Drive's files of one kind, each with its New button) as launcher
  entries of their own, served by the platform under its bar and embedded in the crate (`UI`, from
  `ui/dist`). It heads the Workspace family (`ui.family`), whose navigation Docs draws too.
- Pages: the online editor at `/drive/edit/{file}`, browser editors at `/drive/edit/{file}/{editor}`,
  a viewer at `/drive/view/{file}` (images and documents in the page, PDFs in the browser's viewer),
  `/drive/item/{id}` for `/open/DriveFile/{id}` and `/open/DriveFolder/{id}`. Documents edited live
  open in Docs' editor (`/docs/d/{file}`), or in the viewer where Docs is not installed.
- For other apps: the intents `pick file` (`{files: [{id, name, size, url}]}`), `preview file` and
  `share file` (`{id}`), and the contextual side panel `details` (comments, versions, activity of
  `{file}`).
- Shared links' page is Drive's public page `/drive/s/{workspace}/{link}` (`shell.public`); guest
  invitations and new links name it. Links mailed before keep working (the web app sends
  `/app/s/…` there).
- Uploads go through the shell, which carries on with them in other pages; an upload sent with an
  `Idempotency-Key` is stored once, so one sent again after its page went away returns the file it
  made.
- Needs Ferrum platform 0.3.2.

## 0.7.1

- The online editor talks to the web app (Ferrum docs/plan/collaboration.md, C2). CheckFileInfo
  names the web app's origin (`PostMessageOrigin`, from `PUBLIC_URL`). It asks the editor to hand
  its Share button (Manage access only), version history and close button to the page, which opens
  Drive's own panels, and gives the person's email (`UserExtraInfo`). Collabora's page is opened
  with `closebutton=1` and `revisionhistory=1`, which show those two buttons.
- Presence marks someone editing a file a browser editor holds (`"editor": "browser"`), so the web
  app offers to join only people editing together.

## 0.7.0

- Documents for people and AI agents. `create_document` makes a live document from Markdown,
  `read_document` reads one (as its editors left it, or a version) as Markdown, text or HTML, and
  `append_to_document` adds Markdown at the end as a change everyone with it open sees at once.
- Search finds live documents by what they say, with a one-line `snippet`; their words are kept
  whenever a version is written or something is added (`005_documents.sql`), and upkeep keeps
  those of older documents. `live` keeps search, recent, starred and shared-with-me to them.
- Browser editors 0.1.1: the add-on accepts any Drive since 0.4 (0.1.0 asked for 0.4.x, so Drive
  could not be upgraded where it was installed). Upgrade Browser editors first, then Drive.

## 0.6.0

- Live documents (Ferrum docs/plan/collaboration.md, C3): `.fdoc` files everyone with access edits
  at once in the web app, over the platform's `/ws/docs/drive/{file}`. View and Comment read them,
  Edit and Manage change them. What their editors typed becomes a new version when they leave or
  every ten minutes. Uploads and check-out never replace one; restoring a version makes a copy.
  Copies, downloads and exports (HTML, PDF, text) take the live content, and guests on a link see
  it as a page. `POST /new?kind=fdoc` makes one.

## 0.5.0

- Guests (Ferrum docs/plan/collaboration.md, C5). Sharing with someone outside the workspace makes a Download link for them alone and mails it to them, under the workspace's rules for public links. Sharing with them again replaces it; deactivated colleagues are refused. Links carry the `email` they were sent to, and the report Drive Public Links shows it.
- `create_link` answers the address of the web app's page for the link (`page`), which people open, beside the API address (`url`).

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
