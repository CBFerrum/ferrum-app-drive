// What Drive's screens know about files and folders: their shape as the server lists them, what a
// name says about them, the person's level on them, and which editor opens a file. Pure, so it is
// tested without a browser.

export interface Item {
  id: string;
  kind: "file" | "folder";
  name: string;
  parent?: string | null;
  owner?: string | null;
  size: number | null;
  modified_at: string;
  modified_by: string | null;
  permission: string;
  locked_by: string | null;
  starred?: boolean;
  trashed?: boolean;
  /** Document, Spreadsheet, Presentation, PDF, Image, Video, Audio, Archive, Text or Other. */
  file_type?: string | null;
  /** The top folder of the team folder the item is in; none in a personal space. */
  team?: string | null;
  is_team?: boolean;
  /** Found by a search: where it is, and for a document found by its words, where in it. */
  path?: string | null;
  snippet?: string;
  /** Shared with me: who shared it, and until when. */
  shared_by?: string | null;
  share_expires_at?: string | null;
  /** In the trash: when it went there. */
  trashed_at?: string | null;
}

/** What the share dialog needs to know of an item. */
export type Shareable = Pick<Item, "id" | "name" | "kind">;

/** One item in full (`item_info`): where it is, its versions and comments. */
export interface ItemInfo extends Item {
  parent: string | null;
  version?: number | null;
  created_at?: string;
  breadcrumbs?: Crumb[];
}

export interface Crumb {
  id: string;
  name: string;
}

export interface Listing {
  folder: Item;
  breadcrumbs: Crumb[];
  items: Item[];
  total: number;
  folders: number;
  files: number;
  limit: number;
  offset: number;
}

/** Documents edited live (`.fdoc`): Docs' editor opens them. */
export const isLiveDoc = (name: string) => /\.fdoc$/i.test(name);

/** A name as people see it: a live document's without its `.fdoc`. */
export const shownName = (name: string) => (isLiveDoc(name) ? name.slice(0, -5) : name);

export const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** What a person may do with an item, weakest first (the roles' `permission`). */
const LEVELS = ["View", "Comment", "Edit", "Manage"];
export const allows = (permission: string, needed: string) => LEVELS.indexOf(permission) >= LEVELS.indexOf(needed);

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** What a glyph shows: a folder, or the kind of file its name says. */
export type Look = "folder" | "text" | "sheet" | "slides" | "pdf" | "image" | "video" | "audio" | "archive" | "file";

const LOOKS: [RegExp, Look][] = [
  [/\.(fdoc|docx?|odt|rtf|txt|md)$/i, "text"],
  [/\.(xlsx?|ods|csv|tsv)$/i, "sheet"],
  [/\.(pptx?|odp)$/i, "slides"],
  [/\.pdf$/i, "pdf"],
  [/\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i, "image"],
  [/\.(mp4|mov|webm|mkv|avi)$/i, "video"],
  [/\.(mp3|wav|ogg|m4a|flac|aac)$/i, "audio"],
  [/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i, "archive"],
];

export const lookOf = (kind: "file" | "folder", name: string): Look => (kind === "folder" ? "folder" : (LOOKS.find(([re]) => re.test(name))?.[1] ?? "file"));

/** Files the editor server opens (it says which in its discovery; these are the common ones). */
const OFFICE = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|csv)$/i;
export const editable = (name: string) => OFFICE.test(name);

/** Files Drive shows in its own viewer (`/drive/view/{file}`). */
export const viewable = (name: string) => /\.(pdf|png|jpe?g|gif|webp|svg|avif|fdoc)$/i.test(name);

/** A browser editor an add-on contributes to `drive.editor`. */
export interface BrowserEditor {
  id: string;
  title: string;
  kind: "browser";
  program: string;
  types: string[];
  max_mb?: number;
  app: string;
  version: string;
}

export interface EditorChoice {
  key: string;
  label: string;
  to: string;
  /** Another app's page (Docs' editor): a page load, not a move inside Drive. */
  external?: boolean;
  /** Why it cannot open this file. */
  unavailable?: string;
}

/** Editors several people use at once on one file (browser editors are one person's at a time). */
export const shared = (key: string) => key === "online" || key === "live";

/** The editor "Open" uses: the first that can take the file. On narrow screens browser editors,
 *  made for a mouse and keyboard, are offered under "Open with" only. */
export function defaultEditor(choices: EditorChoice[], narrow: boolean): EditorChoice | undefined {
  return choices.find((c) => !c.unavailable && (c.key === "online" || c.key === "live" || c.key === "view" || !narrow));
}

/** The editors that open a file, the default first: Docs' editor for live documents, the online
 *  editor for office files, then the browser editors for its type; else Drive's viewer. */
export function editorsFor(
  file: { id: string; name: string; size: number | null },
  e: { online: boolean; browser: BrowserEditor[]; docs?: boolean },
): EditorChoice[] {
  const id = encodeURIComponent(file.id);
  const view: EditorChoice = { key: "view", label: "Viewer", to: `/drive/view/${id}` };
  if (isLiveDoc(file.name)) return e.docs === false ? [view] : [{ key: "live", label: "Document editor", to: `/docs/d/${id}`, external: true }, view];
  const out: EditorChoice[] = [];
  if (e.online && editable(file.name)) out.push({ key: "online", label: "Online editor", to: `/drive/edit/${id}` });
  const ext = extension(file.name);
  for (const b of e.browser.filter((b) => b.types.includes(ext))) {
    const tooLarge = b.max_mb && (file.size ?? 0) > b.max_mb * 1024 * 1024;
    out.push({ key: b.id, label: b.title, to: `/drive/edit/${id}/${encodeURIComponent(b.id)}`, unavailable: tooLarge ? `larger than ${b.max_mb} MB` : undefined });
  }
  if (viewable(file.name)) out.push(view);
  return out.sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable));
}
