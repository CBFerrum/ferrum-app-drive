<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Drive: files, live documents, spreadsheets, presentations and PDFs, on your own server" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.16.2-ca8a04?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
[![CI](https://github.com/CBFerrum/ferrum-app-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/CBFerrum/ferrum-app-drive/actions/workflows/ci.yml)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React%20%2B%20TypeScript-interface-0ea5e9?style=flat-square&logo=react&logoColor=white)
![Tests](https://img.shields.io/badge/tests-36%20Rust%20%C2%B7%20135%20interface-16a34a?style=flat-square)

### Your team's files, versions, sharing and Office documents in one self-hosted drive.

Ferrum Drive is for teams that use Google Drive, OneDrive or Dropbox and want their files, and the rules about who can see them, on their own server. It holds personal spaces and team folders, keeps every version, shares with people and expiring links, and opens documents, spreadsheets, presentations and PDFs in the browser. It also gives **Sheets**, **Slides** and **PDF** their own entries in the Ferrum launcher.

[💡 Why](#-why-ferrum-drive) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Ferrum Drive

- 🏠 **Self-hosted, open source, AGPL-3.0.** Files stay on your servers, with no per-seat licence.
- 🔐 **One rule for every file.** A person's level on an item (View, Comment, Edit or Manage) is the highest of their own space, their team folder role and unexpired shares on the item or any folder above it. Access is checked on every request, so removing a share or an expiry passing applies at once.
- 🕵️ **Nothing leaks around it.** Folders, files, versions, shares, links and comments cannot be read through the platform's generic record API except by Drive administrators, and nobody writes them there. An item you may not see answers "not found".
- 👥 **Written together.** Documents (`.fdoc`) are edited live by everyone with access in [Ferrum Docs](https://github.com/CBFerrum/ferrum-app-docs), and Word, Excel and PowerPoint files open in the online office editor your operator runs.
- 🤖 **For people and AI agents.** Every operation is an action on your own Drive Space, so AI agents list, search, read, upload, share and make documents over Ferrum's MCP server under your permissions.
- 🔗 **The file picker of the whole platform.** Other Ferrum apps pick, preview and share Drive files through intents, and Mail attaches from Drive and saves attachments to it.
- 🌍 **Many languages.** The interface comes in English, Arabic and Hindi and mirrors for right to left.

## 🎯 At a glance

| | |
|---|---|
| 📦 **Version** | 0.16.2 |
| 🖥️ **Kind** | Its own interface: four launcher apps, Drive at `/drive/`, Sheets at `/sheets/`, Slides at `/slides/` and PDF at `/pdf/` |
| ➕ **What it adds** | 12 entities (with team members) in one package, 2 roles, 5 reports, 4 launcher apps, 3 intents, a contextual side panel, bar search, a public link page and an add-on for browser editors |
| 🧱 **Depends on** | The platform's `core` package. Nothing else is required |
| 🤝 **Works with** | Docs (live documents, in the same Workspace family), Mail (attach from Drive, save attachments to Drive, share notices) and any app that picks, previews or shares files |
| 🌍 **Languages** | English, Arabic, Hindi |
| 🧪 **Tests** | 36 Rust test functions and 135 interface tests, counted from the source |
| 📄 **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-list-dark.webp"><img alt="Drive — a folder as a list" src="docs/assets/screens/drive-list-light.webp" width="100%"></picture>
<p align="center"><b>📁 Drive — a folder as a list</b><br><sub>Files and folders with their type, date and size; sort, filter and search above the list.</sub></p>

### 📁 Drive

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-grid-dark.webp"><img alt="Drive — a folder as a grid with thumbnails" src="docs/assets/screens/drive-grid-light.webp"></picture>
<p><b>📁 Drive — a folder as a grid with thumbnails</b><br><sub>The same folder as thumbnails.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-pdf-dark.webp"><img alt="Drive — a PDF preview with search" src="docs/assets/screens/drive-preview-pdf-light.webp"></picture>
<p><b>📁 Drive — a PDF preview with search</b><br><sub>Read a PDF in place and search inside it.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-image-dark.webp"><img alt="Drive — a picture preview" src="docs/assets/screens/drive-preview-image-light.webp"></picture>
<p><b>📁 Drive — a picture preview</b><br><sub>Open a picture, zoom and rotate it.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-video-dark.webp"><img alt="Drive — a video preview" src="docs/assets/screens/drive-preview-video-light.webp"></picture>
<p><b>📁 Drive — a video preview</b><br><sub>Play a video without leaving Drive.</sub></p>
</td>
</tr>
</table>

<details>
<summary>📸 More Drive screens: previews, details, sharing and menus</summary>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-markdown-dark.webp"><img alt="Drive — a Markdown preview" src="docs/assets/screens/drive-preview-markdown-light.webp"></picture>
<p><b>📁 Drive — a Markdown preview</b><br><sub>A Markdown file shown formatted.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-spreadsheet-dark.webp"><img alt="Drive — a spreadsheet preview with Edit online" src="docs/assets/screens/drive-preview-spreadsheet-light.webp"></picture>
<p><b>📁 Drive — a spreadsheet preview with Edit online</b><br><sub>A spreadsheet previews in place; Edit online opens it in the editor.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-preview-details-dark.webp"><img alt="Drive — file details" src="docs/assets/screens/drive-preview-details-light.webp"></picture>
<p><b>📁 Drive — file details</b><br><sub>Details of a file: owner, size, dates and where it is.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-share-dialog-dark.webp"><img alt="Drive — the share dialog" src="docs/assets/screens/drive-share-dialog-light.webp"></picture>
<p><b>📁 Drive — the share dialog</b><br><sub>Share a file with people or by link, and set what each may do.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-item-menu-dark.webp"><img alt="Drive — a file&#x27;s menu" src="docs/assets/screens/drive-item-menu-light.webp"></picture>
<p><b>📁 Drive — a file&#x27;s menu</b><br><sub>Open, share, rename, move, copy, download or delete a file from its menu.</sub></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

### 📊 Sheets

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/sheets-editor-dark.webp"><img alt="Sheets — a spreadsheet in the online editor" src="docs/assets/screens/sheets-editor-light.webp"></picture>
<p><b>📊 Sheets — a spreadsheet in the online editor</b><br><sub>An Excel file opens in the editor with its data, formulas and chart; changes are saved to Drive as you go.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/sheets-formula-editing-dark.webp"><img alt="Sheets — editing a formula" src="docs/assets/screens/sheets-formula-editing-light.webp"></picture>
<p><b>📊 Sheets — editing a formula</b><br><sub>Click a cell to see its formula in the formula bar; double-click to edit it in the cell.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/sheets-two-people-dark.webp"><img alt="Sheets — two people in the same spreadsheet" src="docs/assets/screens/sheets-two-people-light.webp"></picture>
<p><b>📊 Sheets — two people in the same spreadsheet</b><br><sub>Each person&#x27;s cursor and name show to the other while you work together.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/sheets-viewer-dark.webp"><img alt="Sheets — the same spreadsheet for a person who can only view" src="docs/assets/screens/sheets-viewer-light.webp"></picture>
<p><b>📊 Sheets — the same spreadsheet for a person who can only view</b><br><sub>A person with view-only access sees the data but cannot change it.</sub></p>
</td>
</tr>
</table>

### 🎞️ Slides

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/slides-editor-dark.webp"><img alt="Slides — a presentation in the online editor" src="docs/assets/screens/slides-editor-light.webp"></picture>
<p><b>🎞️ Slides — a presentation in the online editor</b><br><sub>A PowerPoint file opens in the editor with its slides on the left and the slide in the middle.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/slides-slide-two-dark.webp"><img alt="Slides — the second slide" src="docs/assets/screens/slides-slide-two-light.webp"></picture>
<p><b>🎞️ Slides — the second slide</b><br><sub>Pick a slide in the strip to edit it.</sub></p>
</td>
</tr>
</table>

### 📱 On a phone

<p align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/drive-list-phone-dark.webp"><img alt="Drive — a folder as a list" src="docs/assets/screens/drive-list-phone-light.webp" width="260"></picture>
</p>
<p align="center"><sub>Files and folders with their type, date and size; sort, filter and search above the list.</sub></p>

> [!NOTE]
> Sheets and Slides are opened in an office editor that your operator runs next to Ferrum (see [Install](#-install)). The screenshots follow your GitHub theme: switch between light and dark to see both.

## ✨ Features

### 📁 Spaces, folders and the list

- **Personal spaces and team folders.** Everyone has a space of their own. A team folder has members as Viewer, Commenter, Editor or Manager, and Drive administrators create team folders and set each one's size limit. Everyone sees their own storage, amber near the limit.
- **Folders of any size.** Lists load a hundred at a time as you scroll, say "Showing 300 of 1,340" and have a Show more button. Search results, trash and the Sheets, Slides and PDF pages page the same way.
- **List and grid.** Each item shows its kind (folder, document, spreadsheet, presentation, PDF, image, video, sound, archive) in its kind's colour. A grid view shows small pictures as thumbnails; large pictures and PDFs show a type icon.
- **Sort and filter.** Sort by name, date, size or type either way, and filter by type, when it changed, who owns it and where it is. They combine with search and live in the address.
- **Several at once.** Choose items with the boxes (Shift for a stretch) and move, copy, share, download or trash them all.
- **Drag and drop.** Drag items onto a folder in the list, the path above it or the places beside it (Ctrl or Option copies), or use a folder picker from a menu by keyboard or touch. Drop files and folders on the page to upload them, folders with their contents; the page says what it will do and leaves out what it would refuse, with the reason.
- **Rename inline** with F2, **star** items, and use the clipboard keys (Ctrl or ⌘ C, X, V and A).
- **Undo.** Move, copy, trash and rename say what happened and offer Undo; trash no longer asks first.
- **Recent, Starred, Shared with me and Trash** as places of their own. Recent shows the last 100 items.
- **Keys.** `j` and `k` or the arrows move, `x` chooses, `m` moves, `c` copies, `h` shares, `s` stars, F2 renames, Delete trashes, `n` makes a folder, `u` uploads, Space previews, `/` searches and `?` lists them.
- **The bar's search** (⌘K or Ctrl+K) finds files and folders by name and live documents by their words.

### 👁️ Previews that cannot change a file

- **In place.** Opening a file shows it inside Drive, with the arrow keys moving through the folder and Escape closing: pictures (fit, zoom, rotate), video and audio (ranged requests, so they seek), PDF drawn in the page with page numbers, zoom, selectable text and a search that marks the matched word, text, Markdown, CSV as a table, JSON and code.
- **Office files** open read-only in the online editor. Without an editor, the page says what the administrator has to turn on, with Download.
- **A preview can never write.** A preview's editor session gets a token that cannot write, whoever is looking, so saves and locks are refused for it. "Edit online" starts a real session.
- **Details.** Owner, size, type, dates, where it is, who has access and its comments, in a panel that also opens beside other apps' screens.

### 🕒 Versions and locks

- **Upload a new version** of a file, name a version and keep it, restore or download any version. Drive says how many versions it keeps (set by the administrator). A kept version is never pruned and does not count against the limit (at most 25 kept per file).
- **A name clash asks once:** keep both, replace as a new version, or skip, for one file or for all.
- **Restore.** Restoring an old version adds it again as the newest. For a live document it makes a copy beside it, called "Name (version N)".
- **One editor at a time.** One editor lock per file, shared by the online editor and browser editors, records who holds it. Others open the file read-only and are told who is editing, and uploads and restores are refused until the session closes.
- **Check out and check in** are available as actions to people and AI agents; the screens show a Checked out badge.

### 🔗 Sharing and links

- **People and roles.** Share an item with a person (by email) or with everyone who holds a role, as View, Comment, Edit or Manage, with an optional end date. Shares on a folder pass to everything inside it. The person is notified in the app and, with the Mail app, by email.
- **Who has access, in groups.** The owner, the team folder, people given the item, and, under the folder each comes down from, those who have it through a folder above. A person's role changes in place.
- **Public links** are set up before they are made: who may do what with the link (view or view and download), when it ends, a password (with one made for you to read out), a limit on uses, and a note the people who open it read. A link is shown once when made and cannot be shown again.
- **Workspace rules first.** The dialog shows the workspace's link rules ("Links in this workspace need a password and end within 7 days"), asks for what they require and says so before a link is refused. Sharing outside the workspace says at once when the rules do not allow it.
- **Links already made** are listed with how they stand (working, ended, used up), their uses, and when each was last opened.
- **Guests.** Sharing with someone outside the workspace makes a view link for them alone, mailed to them under the workspace's rules for public links. Sharing again replaces it.
- **Request access.** Someone who cannot open an item can ask its owner, or a team folder's managers, to share it. A request counts once a day, and the answer never says whether the item exists.
- **Links that belong to the workspace.** A link can name someone who can manage the item to answer for it, and then stays when its maker leaves.
- **A public page.** Anyone with a link opens a shared file or folder at `/drive/s/{workspace}/{link}`, with the link's note.

### 💬 Comments and presence

- **Comments** on a file, with @mentions (those who may see the file are told in the bell and by mail, and the owner hears of comments by others) and threads with replies.
- **Comments on a live document's text.** Anchored to the words, with Resolve and Reopen; the details panel shows the words a comment is on and who resolved it.
- **Presence.** Open pages report who has a file open, viewing or editing, for 90 seconds, so people can join the right file.

### ⬆️ Uploads and downloads

- **Large files in parts.** Files over the single-request limit upload in resumable parts, up to the platform's 2 GiB. A connection that drops or stalls for 30 seconds retries with backoff from the last part the server has, and going offline waits instead of using up tries. Progress shows in the bar's upload tray with Stop and Retry. Stop removes what was sent.
- **Same upload, once.** An upload sent with an idempotency key is stored once, so one sent again after its page went away returns the file it made.
- **Limits said first.** The upload limit is shown before the upload starts. The workspace's limit holds by itself (up to 1,024 MB); the server's single-request limit is `FERRUM_DRIVE_MAX_FILE_MB` (32 MB unless raised).
- **Downloads stream** from storage, whatever their size, and a folder or a selection downloads as one zip (names made safe, duplicates numbered, live documents as web pages, capped at 128 MB and 5,000 files).
- **Live documents export** from Drive and from public links as Word, PDF, HTML, text and Markdown, with the formatting kept. When a format could not carry something, the download says so. A Word export carries comment threads with their replies and authors.

### 🧩 Templates

- **Start from a template.** New offers "From a template…" beside the blank files, and Sheets and Slides offer their own.
- **Built in.** Word documents (Meeting notes, Project brief, Report, Letter), Excel workbooks (Budget, Expense report, Task tracker) and PowerPoint presentations (Project update, Team meeting).
- **Your own.** A Drive administrator saves any Word, Excel, PowerPoint or OpenDocument file as one of the workspace's templates from its menu (up to 200 per workspace), keeping its own copy. A new file's name keeps an extension it already has.

### 🗑️ Trash, quotas and upkeep

- **Trash** says when things are purged. Empty trash and Delete forever name and count what goes. Restoring puts an item back in place, renamed `name (2)` on a clash, and items inside a trashed folder come back with it. Items in the trash longer than the workspace's days (30 by default) are deleted for good by a job that runs every minute.
- **Quotas.** A default for each person and each team folder, and an adjustable limit per space and team folder. A storage-quota error says what a file uses and what it needs.
- **Expired shares** are removed by the same job and noted in the item's activity.
- **Activity.** Uploads, previews as views, downloads, moves, shares, public-link access and deletions, by whom. Grid thumbnails and the later parts of a ranged read count as nothing.

### 🧑‍💼 Administration and reports

- **Settings** for the whole workspace: upload limit, default quotas for people and teams, how long trash is kept, how many versions are kept, whether public links are allowed, the longest a link may last, whether links need a password, and what happens to links when their maker leaves.
- **Five reports:** Drive Storage By User, Drive Storage By Team, Drive Storage By Type, Drive Largest Files, and Drive Shared Externally (active links, all links, or the links someone's departure went through, as an access review).
- **When someone leaves.** What they had checked out opens up, shares made to them end, their files, folders and team membership move to a successor, and the successor gets Manage on their space. Each of their public links is passed on, stays, stops or is kept, and says so in the share dialog and the report.
- **Personal data.** A person's request reaches what Drive keeps of them: an erasure blanks their name on versions, shares, links, comments, activity and stars. Files, folders and spaces they own are exported and kept until handed over.

### 📊 Sheets, 🎞️ Slides and 📄 PDF

- **Their own launcher entries.** Sheets, Slides and PDF are Drive's files of one kind, each with its own New button, template gallery and list.
- **Office files in the browser.** With an office editor server (Collabora Online, or ONLYOFFICE Docs in WOPI mode) that your operator runs, Excel, PowerPoint and Word files open and are edited together in the page. The editor opens in Ferrum's light or dark theme and language, shows presence, saves each change as a new version with the person's own Drive rights, and says "The office editor is not answering. Your file is safe in Drive." with Retry and Download when it does not answer.
- **Browser editors add-on.** An add-on shipped with Drive contributes GridCraft (xlsx, csv, tsv), WordCraft (docx, odt, rtf) and PdfCraft (pdf) from an editor server (`FERRUM_EDITORS_URL`). They run in the person's browser, and each save is a new version.
- **Read-only for viewers.** Viewers of a spreadsheet or deck see the data without being able to change it.
- **Documents opened as live documents.** A Word file offers "Open as a Ferrum document" when Docs is installed, last in the Open with list and never the default; the Word file is left as it is. Live documents open in Docs.
- **PDF in the page.** Page numbers, zoom, selectable text and search that marks the matched word, with no add-on. Editing a PDF needs the PdfCraft add-on.

### 🔌 For other apps and AI agents

- **Intents.** `pick file` answers `{files: [{id, name, size, url}]}`, `preview file` and `share file` take `{id}`, and a contextual **Comments and history** side panel shows a file's details.
- **Open from anywhere.** `/open/DriveFile/{id}` and `/open/DriveFolder/{id}` open an item.
- **Actions** on your Drive Space for people and agents, over the REST API or MCP: list, search, recent, starred, shared with me, trash, usage, item info, versions, download, shares, links, activity, comments, upload, upload a version, create a folder, team folders and members, rename, move, copy, trash, restore, delete forever, empty trash, check out and in, restore or keep a version, share, unshare, create and revoke links, star, comment, request access, create, read and append to documents, and templates.
- **The assistant** knows what Drive's records mean and suggests questions such as "Which files are shared outside with a link?" and "What takes the most space?".

## 🧭 How it works

### From a file to a shared, versioned document

```mermaid
flowchart LR
    U["Person or AI agent"] --> A["Drive action - on their own space"]
    A --> ACL{"Level is enough? - space, team folder, share"}
    ACL -->|yes| F["File and versions - platform file storage"]
    ACL -->|no| N["Not found or forbidden"]
    F --> L["Live document - edited in Docs"]
    F --> O["Office editor - WOPI, locks, new version"]
    F --> S["Shares and public links"]
    F --> T["Trash, quotas, activity"]
```

Every request is checked against the same rule: the highest of the person's own space, team folder role and shares on the item or any folder above it. Bytes are platform files owned by no user, so nothing reaches them except through Drive.

### Inside Ferrum

```mermaid
flowchart LR
    subgraph Browser
        UI["Drive, Sheets, Slides, PDF"]
        BAR["Ferrum bar - search, upload tray"]
    end
    subgraph Server["Ferrum server"]
        API["REST, MCP, live"]
        K["Kernel - permissions, RLS, audit"]
        APP["Drive - 12 entities, 2 roles"]
    end
    DB[("PostgreSQL")]
    FS[("File storage")]
    OFF[("Office editor - operator runs")]
    UI --> API --> K --> DB
    BAR --> API
    K <--> APP
    APP --> FS
    APP <--> OFF
```

Drive is ordinary Ferrum metadata and Rust, so its records get the platform's permissions, audit trail and APIs. An office editor reads and saves files through Drive's own checks, with a token bound to the workspace, the file, the person and an expiry.

## 🧱 Data model

| Entity | What it is | Key fields |
|---|---|---|
| Drive Space | A person's Drive: personal folders and quota. Every operation is an action on your own space | owner, quota, used bytes, root folder |
| Drive Folder | A folder in a space or a team folder | name, parent, owner, team flag, members, quota, colour, trashed |
| Drive File | A file and its current version | name, folder, type, size, hash, version, locked by, trashed |
| Drive File Version | One stored version | file, number, size, hash, author, comment, kept, label |
| Drive Share | Access to a file or folder for one person or a role | item, email or role, permission, level, expires |
| Drive Link | A public link | item, access, password, expires, max downloads, count, revoked, note, email |
| Drive Comment | A comment, threaded, optionally on a range of a live document | file, author, body, reply to, anchor, quote, resolved |
| Drive Activity | What happened, by whom | item, action, actor, details |
| Drive Star | A person's star | email, file or folder |
| Drive Template | A template for new Office files | title, file kind, category, description |
| Drive Settings | The workspace's rules | upload limit, quotas, trash days, versions, link policy |
| Drive Team Member | A member of a team folder | member, role |

### 👥 Roles

| Role | What it can do |
|---|---|
| **Drive User** | Reads and creates their own Drive Space, reads Drive Settings; everything else through actions on their space, checked against sharing |
| **Drive Administrator** | Manages Drive settings and quotas, creates team folders, saves templates, reads and exports every folder, file, version, share, link, activity and comment, runs the reports, and has Manage on every item |

### 📊 Reports and jobs

- **Reports:** Drive Storage By User, Drive Storage By Team, Drive Storage By Type, Drive Largest Files, Drive Shared Externally.
- **Upkeep, every minute:** delete trash older than the workspace's days (50 per run), remove expired shares.

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| Docs | `.fdoc` live documents edited together; Word files offer "Open as a Ferrum document" | Docs `0.8` or later for the Word offer |
| Mail | Attach from Drive, save attachments to Drive; share notices by email | The Mail app (Comms) |
| Other apps | Pick, preview and share through intents; open by `/open/DriveFile/{id}` | Nothing |
| Collabora Online or ONLYOFFICE Docs | Online editing of Word, Excel and PowerPoint files over WOPI | `FERRUM_OFFICE_URL`, `FERRUM_OFFICE_WOPI_URL`, optionally `FERRUM_OFFICE_IPS` to limit callers |
| Browser editors add-on | GridCraft, WordCraft and PdfCraft in the browser | `FERRUM_EDITORS_URL` and the add-on installed |
| Platform exporters | Word, PDF, HTML, text and Markdown of live documents | The platform's document renderer for PDF |
| Platform uploads in parts | Large files past the single-request limit | Included |
| Webhooks and automations | Outbox events of its records | Platform webhooks |

## 📊 How it compares

Drive is compared with Google Drive, OneDrive (with SharePoint), Dropbox and Nextcloud, the open and self-hosted option.

### 📁 Drive

| Capability | Ferrum Drive | Google Drive | OneDrive | Dropbox | Nextcloud |
|---|:-:|:-:|:-:|:-:|:-:|
| Upload files and folders by drag and drop | ✅ | ✅ | ✅ | ✅ | ✅ |
| Resumable uploads of large files | ✅ | ✅ | ✅ | ✅ | ✅ |
| Team folders with roles | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sharing with people and roles, inherited by folders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Public links with password, end date and use limit | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Comments with @mentions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Version history, named and kept versions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Trash, restore and auto-purge | ✅ | ✅ | ✅ | ✅ | ✅ |
| Quotas per person and team | ✅ | ✅ | ✅ | ✅ | ✅ |
| Search by name with type, owner and date filters | ✅ | ✅ | ✅ | ✅ | ✅ |
| Search inside Office and PDF files | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Previews of pictures, video, audio, PDF, text and code | ✅ | ✅ | ✅ | ✅ | ✅ |
| Server-made thumbnails for every file | ❌ ¹ | ✅ | ✅ | ✅ | ✅ |
| Edit Office files together in the browser | 🟡 ² | ✅ | ✅ | 🟡 | ✅ |
| Own live document editor | ✅ ³ | ✅ | ✅ | ✅ | ✅ |
| Download a folder as a zip | ✅ | ✅ | ✅ | ✅ | ✅ |
| Desktop sync client | ❌ | ✅ | ✅ | ✅ | ✅ |
| WebDAV mount | ❌ | ❌ | 🟡 | ❌ | ✅ |
| Native mobile apps and offline files | ❌ | ✅ | ✅ | ✅ | ✅ |
| Transfer ownership of a file | ❌ ⁴ | ✅ | ✅ | ✅ | ✅ |
| Activity log per item | ✅ | ✅ | ✅ | ✅ | ✅ |
| Admin reports: storage, largest files, shared outside | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Virus scanning of uploads | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Retention policy and legal hold | ❌ | ✅ | ✅ | ✅ | 🟡 |
| What happens to files and links when a person leaves | ✅ | ✅ | ✅ | ✅ | 🟡 |
| AI agents can use it over MCP | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ✅ |
| Open source | ✅ | ❌ | ❌ | ❌ | ✅ |
| No per-user licence fee | ✅ | ❌ | ❌ | ❌ | ✅ |

¹ Pictures up to 1 MB show themselves in the grid; larger pictures and PDFs show a type icon.
² Needs an office editor server (Collabora Online or ONLYOFFICE Docs) that your operator runs. The platform ships Collabora on by default in its standard deployments.
³ Live documents are edited in Ferrum Docs.
⁴ When someone leaves, their files move to a successor; handing a file to someone else while the owner stays is not built.

### 📊 Sheets, Slides and PDF

What you can do in a spreadsheet or a deck is decided by the office editor your operator runs, not by Ferrum. This table covers what Ferrum itself provides around it.

| Capability | Ferrum | Google Sheets and Slides | Excel and PowerPoint | ONLYOFFICE Docs |
|---|:-:|:-:|:-:|:-:|
| Create, open and edit `.xlsx` and `.pptx` in the browser | ✅ ¹ | ✅ | ✅ | ✅ |
| Several people in one spreadsheet, with cursors | ✅ ¹ | ✅ | ✅ | ✅ |
| Several people in one presentation | 🟡 ² | ✅ | ✅ | ✅ |
| Viewers who cannot change the file | ✅ | ✅ | ✅ | ✅ |
| Automatic saving as versions | ✅ ¹ | ✅ | ✅ | ✅ |
| Named and kept versions, restore, download | ✅ | ✅ | ✅ | ✅ |
| Templates for sheets and decks | ✅ | ✅ | ✅ | ✅ |
| Speaker notes and presenting | 🟡 ² | ✅ | ✅ | ✅ |
| Live business data in a sheet or slide | ❌ | 🟡 | 🟡 | ❌ |
| Macros and scripts | ❌ | ✅ | ✅ | ✅ |
| Thumbnails of decks and sheets in the file list | ❌ | ✅ | ✅ | 🟡 |
| View and search a PDF in the page | ✅ | ✅ | ✅ | ✅ |
| Annotate, fill and sign PDFs in the browser | 🟡 ³ | ❌ | 🟡 | 🟡 |
| OCR of scanned PDFs | ❌ | ✅ | 🟡 | 🟡 |
| Self-hosted and open source | ✅ | ❌ | ❌ | ✅ |

¹ With the online editor server in place; each autosave is a new version after about 10 to 20 seconds. Editors from the browser-editors add-on save when the person saves.
² Opening, notes and presenting inside the frame work; co-editing was exercised in spreadsheets, and presenter view and a second display have not been tried.
³ Needs the PdfCraft add-on; the in-page PDF viewer is read-only.

### 🏆 Where Drive stands out

- 🔐 One access rule everywhere, with nothing readable around it through the platform's generic API.
- 🔗 Links that belong to the workspace and pass on, stay or stop when someone leaves, with an access-review report. Requests for access go to the owner or a team folder's managers without saying whether an item exists.
- 🤖 Every operation is an action that AI agents can run under a person's own permissions.
- 🧪 Previews that can never change a file, and uploads that survive dropped connections.
- 🧩 One file store that Docs uses for its documents and Mail uses for attachments, with intents any app can use.
- 🏠 Open source, self-hosted, no per-seat licence.

### 🚧 Where the leaders are still ahead

- 💻 Desktop sync, WebDAV, offline files and native mobile apps.
- 🔎 Search inside Office and PDF files, and thumbnails made by the server.
- 🛡️ Virus scanning, retention policies and legal holds.
- 🔁 Handing ownership of a single file to someone else.
- 📈 Macros, scripts and live business data in sheets and decks.

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change.

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.16.2**: The online editor opens in Ferrum's light or dark theme, whatever the browser's own scheme.
- [x] **0.16.1**: Comments in Word exports, Stop that discards a large upload, large uploads in the bar's tray.
- [x] **0.16.0**: Previews in place, previews that cannot write, named and kept versions, zip download, resumable uploads, Undo, filters, exports that keep formatting.
- [x] **0.15.0**: Links that belong to the workspace, and what became of each link when someone left.
- [x] **0.14.0**: Files past the request limit go in parts that survive a dropped connection.
- [x] **0.13.0**: Downloads stream from storage.

### 🔜 Next up

**Files**
- [ ] Search inside Office and PDF files.
- [ ] Thumbnails made by the server for large pictures, PDFs and Office files.
- [ ] Download an Office file as a PDF.
- [ ] Transfer ownership of a file or folder.

**Sync**
- [ ] A WebDAV mount using app passwords.
- [ ] A desktop sync folder and offline use.

**Safety**
- [ ] Virus scanning of uploads.
- [ ] Retention policies and legal hold.

**Editors**
- [ ] A setting for which editor opens each file type by default.
- [ ] Show comment authors by display name instead of the address before the `@`.

### 🔭 Later

- [ ] A white document canvas option in dark theme, and switching an open editor's theme without reopening it (needs the editor's support).
- [ ] The bar's upload tray saying that the parts were discarded, not only "Stopped"; closing the page cancelling a large upload.
- [ ] Screens for check out and check in, and for folder colours (both exist as actions).
- [ ] Link files to business records, with a Drive filter.
- [ ] An external-sharing report per person.
- [ ] A wired-in editor for presentations beyond the office editor, and live business data in sheets and decks.
- [ ] Native mobile apps.
- [ ] A screen-reader audit of the new screens.

## 🚀 Install

Drive is a native app compiled into the official Ferrum server image. A workspace administrator installs it from **Apps** (`/store/`). Self-hosters who build their own image enable the `drive` feature of the server. It needs Ferrum platform `>=0.3.2, <0.4`. It heads the **Workspace** family; Docs installs with it.

**First steps**

1. Give people the **Drive User** role and administrators **Drive Administrator**. Everyone's space is made the first time they open Drive.
2. Open **Drive Settings** and set the upload limit, default quotas, how long trash is kept, how many versions are kept and the public link rules.
3. Create **team folders** for departments and set their quotas.
4. For Word, Excel and PowerPoint in the browser, run an office editor server (Collabora Online, or ONLYOFFICE Docs in WOPI mode) and set `FERRUM_OFFICE_URL` and `FERRUM_OFFICE_WOPI_URL` (and `FERRUM_OFFICE_IPS` to accept calls from only those addresses). The platform's standard deployments include one.
5. For GridCraft, WordCraft and PdfCraft, run the editor server, set `FERRUM_EDITORS_URL` and install the **Browser editors** add-on (`drive-editors`) from this repository's `addons/editors`.
6. To raise the single-request upload limit above 32 MB, set `FERRUM_DRIVE_MAX_FILE_MB` (up to 1 GiB). Larger files upload in parts.

Everything Drive adds is also available to AI agents over Ferrum's MCP server, within each person's permissions.

## 🔧 Develop

Clone it next to the platform:

```text
work/
├── ferrum/              https://github.com/CBFerrum/Ferrum (with Ferrum-Frontend cloned into ferrum/web)
└── ferrum-app-drive/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-apps = { path = "../ferrum/crates/apps" }
ferrum-calc = { path = "../ferrum/crates/calc" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role, so row-level security applies:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_drive_test
export FERRUM_DRIVE_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_drive_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The interface lives in `ui/` and builds with Ferrum-Frontend's packages from the sibling checkout:

```bash
cd ui
npm run check       # UI lint and the size budget
npm run typecheck
npm test
npm run build       # writes ui/dist, which the crate embeds and which is committed
```

With a development server started with `FERRUM_DEV_UI=1`, `ferrum-app dev --ui` serves the pages from Vite behind the real bar and session, with hot reload. CI (`.github/workflows/ci.yml`) runs the Rust checks and the interface checks on every push and pull request.

## 📂 Project layout

```text
app.yaml              the manifest: id, version, launcher apps, intents, search, editors point
packages/drive/       entities, roles, reports, SQL migrations, README with the full API
addons/editors/       the Browser editors add-on (GridCraft, WordCraft, PdfCraft)
src/                  Rust: access rules, files and versions, sharing, links, office (WOPI),
                      live documents, templates, archives, upkeep jobs
ui/src/               React interface: list and grid, previews, share dialog, versions, uploads
ui/src/locales/       Arabic and Hindi words
tests/                integration tests against PostgreSQL
docs/                 banner and screenshots
CHANGELOG.md          what changed in each version
```

## 📜 Changelog

Every release is described in [CHANGELOG.md](CHANGELOG.md). The latest is **0.16.2**; **0.16.0** made Drive work the way people expect a drive to.

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-drive](https://github.com/CBFerrum/ferrum-app-drive/issues). Run the checks in [Develop](#-develop) before you open a pull request.

## 📄 License

[AGPL-3.0-only](LICENSE), like the platform.

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
