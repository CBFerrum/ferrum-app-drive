// Drive (the drive app's /api/app/drive endpoints): your files, what others shared with you, recent,
// starred and trashed items, and search; Sheets, Slides and PDF (Drive's files of one kind); upload
// (handed to the shell, so it goes on in other apps' pages), new folders and blank documents,
// spreadsheets or presentations, or ones from a template (Templates.tsx); sharing, comments, versions and activity in a panel beside the
// list (Details.tsx, Share.tsx); who has a file open now (presence.ts). Files open in the editor
// server the operator runs (Collabora Online or ONLYOFFICE, over WOPI), in a browser editor that an
// add-on offers on Drive's `drive.editor` point (BrowserEdit.tsx), or, for documents edited live,
// in Docs' editor (another app's page).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, download, errorMessage, formatDateTime, initials, shell } from "@ferrum/client";
import { Badge, Button, Dialog, EmptyState, FamilyNav, Field, Spinner, Tabs, confirmDialog, toast } from "@ferrum/kit";
import {
  Button as UiButton,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ferrum/kit/primitives";
import {
  ArchiveRestore,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Info,
  LayoutTemplate,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Presentation,
  Share2,
  Sheet,
  Star,
  StarOff,
  Trash2,
  Upload,
} from "lucide-react";
import { type EditorView, applyViews, hostMessage, inkOn, othersOf, parseMessage } from "./wopi";
import { DetailsPanel, type ItemInfo, allows } from "./Details";
import { joinable, presenceLabel, useFilesPresence, usePresence } from "./presence";
import { type Shareable, ShareDialog } from "./Share";
import { SaveTemplateDialog, TemplateDialog, templatable, useTemplates } from "./Templates";

interface Item {
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
}

interface Listing {
  folder: Item;
  breadcrumbs: { id: string; name: string }[];
  items: Item[];
}

interface Launch {
  url: string;
  access_token: string;
  access_token_ttl: number;
  name: string;
  action: "edit" | "view";
}

/** Documents edited live (`.fdoc`): Docs' editor opens them. */
export const isLiveDoc = (name: string) => /\.fdoc$/i.test(name);

/** A name as people see it: a live document's without its `.fdoc`. */
export const shownName = (name: string) => (isLiveDoc(name) ? name.slice(0, -5) : name);

const GLYPHS: [RegExp, LucideIcon, string][] = [
  [/\.(fdoc|docx?|odt|rtf|txt|md)$/i, FileText, "text-blue-600 dark:text-blue-400"],
  [/\.(xlsx?|ods|csv|tsv)$/i, Sheet, "text-green-600 dark:text-green-400"],
  [/\.(pptx?|odp)$/i, Presentation, "text-orange-600 dark:text-orange-400"],
  [/\.pdf$/i, FileText, "text-red-600 dark:text-red-400"],
  [/\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i, FileImage, "text-purple-600 dark:text-purple-400"],
  [/\.(mp4|mov|webm|mkv|avi)$/i, FileVideo, "text-pink-600 dark:text-pink-400"],
  [/\.(mp3|wav|ogg|m4a|flac|aac)$/i, FileAudio, "text-cyan-600 dark:text-cyan-400"],
  [/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i, FileArchive, "text-slate-500 dark:text-slate-400"],
];

/** A folder, or what a file's name says it is, in its kind's colour. */
export function FileGlyph({ kind, name, size = 18 }: { kind: "file" | "folder"; name: string; size?: number }) {
  const [Glyph, tone] = kind === "folder" ? [Folder, "fill-amber-400/25 text-amber-500"] : (GLYPHS.find(([re]) => re.test(name))?.slice(1) as [LucideIcon, string] | undefined) ?? [File, "text-muted-foreground"];
  return <Glyph aria-hidden size={size} className={`shrink-0 ${tone}`} />;
}

/** The apps the person may use (the bar's launcher): whether Docs is one of them. */
export function useApps() {
  return useQuery({
    queryKey: ["shell", "apps"],
    queryFn: () => shell().apps(),
    staleTime: 300_000,
  });
}
export const useDocs = () => !!useApps().data?.some((a) => a.app === "docs");

/** Files the editor server opens (it says which in its discovery; these are the common ones). */
const OFFICE = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|csv)$/i;
export const editable = (name: string) => OFFICE.test(name);

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

/** The editors this server runs (`GET /api/app/drive/editors`) and the browser editors on offer. */
export function useEditors() {
  const kinds = useQuery({
    queryKey: ["drive", "editors"],
    queryFn: ({ signal }) => api.get<{ online: boolean; browser: boolean }>("/api/app/drive/editors", undefined, signal),
    staleTime: 300_000,
  });
  const offered = useQuery({
    queryKey: ["drive", "editors", "browser"],
    queryFn: ({ signal }) => api.get<{ items: BrowserEditor[] }>("/api/meta/contributions/drive.editor", undefined, signal).then((r) => r.items),
    enabled: !!kinds.data?.browser,
    staleTime: 300_000,
  });
  return {
    loading: kinds.isPending || (!!kinds.data?.browser && offered.isPending),
    online: !!kinds.data?.online,
    browser: kinds.data?.browser ? (offered.data ?? []) : [],
  };
}

export const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

export interface EditorChoice {
  key: string;
  label: string;
  to: string;
  /** Another app's page (Docs' editor): a page load, not a move inside Drive. */
  external?: boolean;
  /** Why it cannot open this file. */
  unavailable?: string;
}

/** A link to an editor: inside Drive, or another app's page. */
export function EditorLink({ choice, className, children, ...rest }: { choice: EditorChoice; className?: string; children: React.ReactNode; "aria-label"?: string }) {
  if (choice.external)
    return (
      <a className={className} href={choice.to} {...rest}>
        {children}
      </a>
    );
  return (
    <Link className={className} to={choice.to} {...rest}>
      {children}
    </Link>
  );
}

/** Goes to an editor (inside Drive, or another app). */
export function openChoice(choice: EditorChoice, navigate: (to: string) => void) {
  if (choice.external) shell().navigate(choice.to);
  else navigate(choice.to);
}

/** Editors several people use at once on one file (browser editors are one person's at a time). */
export const shared = (key: string) => key === "online" || key === "live";

/** The editor "Open" uses: the first that can take the file. On narrow screens browser editors,
 *  made for a mouse and keyboard, are offered under "Open with" only. */
export function defaultEditor(choices: EditorChoice[], narrow: boolean): EditorChoice | undefined {
  return choices.find((c) => !c.unavailable && (c.key === "online" || c.key === "live" || c.key === "view" || !narrow));
}


/** Files Drive shows in its own viewer (`/drive/view/{file}`). */
export const viewable = (name: string) => /\.(pdf|png|jpe?g|gif|webp|svg|avif|fdoc)$/i.test(name);

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

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** New files: a live document always; office files open in the online or a browser editor. */
const NEW = [
  { kind: "fdoc", label: "Document" },
  { kind: "docx", label: "Word document" },
  { kind: "xlsx", label: "Spreadsheet" },
  { kind: "pptx", label: "Presentation" },
] as const;

/** Drive's launcher entries for one kind of file (`/sheets/`, `/slides/`, `/pdf/`): everything of
 *  that kind the person can see, and a New button for it. */
export const KINDS = {
  Spreadsheet: { title: "Sheets", fresh: { kind: "xlsx", label: "New spreadsheet" } },
  Presentation: { title: "Slides", fresh: { kind: "pptx", label: "New presentation" } },
  PDF: { title: "PDF", fresh: null },
} as const;
export type FileKind = keyof typeof KINDS;

/** Drive's views besides a folder of your own (`?view=`). */
export const VIEWS = [
  { id: "mine", label: "My files", action: "" },
  { id: "shared", label: "Shared with me", action: "shared_with_me" },
  { id: "recent", label: "Recent", action: "recent" },
  { id: "starred", label: "Starred", action: "starred" },
  { id: "trash", label: "Trash", action: "list_trash" },
] as const;
type View = (typeof VIEWS)[number]["id"];

/** `/drive/:folder?`: a folder of your Drive (your space's top folder by default), or with `?view=`
 *  another view, with `?q=` a search, and with `?item=` an item's details beside the list; with
 *  `kind`, every file of one kind (Sheets, Slides, PDF). */
export function DrivePage({ kind }: { kind?: FileKind }) {
  const { folder } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tabsId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState<Shareable | null>(null);
  const [naming, setNaming] = useState<{ title: string; label: string; initial: string; done: (name: string) => Promise<unknown> } | null>(null);
  const [gallery, setGallery] = useState(false);
  const [saving, setSaving] = useState<Item | null>(null);
  const templates = useTemplates();
  const view: View = VIEWS.find((v) => v.id === params.get("view"))?.id ?? "mine";
  const query = params.get("q") ?? "";
  const selected = params.get("item");
  const [typed, setTyped] = useState(query);
  const space = useQuery({
    queryKey: ["drive", "space"],
    queryFn: ({ signal }) => api.get<{ id: string; root_folder: string }>("/api/app/drive/space", undefined, signal),
  });
  const inFolder = view === "mine" && !query && !kind;
  const id = inFolder ? (folder ?? space.data?.root_folder) : undefined;
  // Where uploads and new files go: this folder, else your top folder.
  const target = id ?? space.data?.root_folder;
  const docs = useDocs();
  const editors = { ...useEditors(), docs };
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
  const list = useQuery({
    queryKey: ["drive", "folder", id],
    queryFn: ({ signal }) => api.get<Listing>("/api/app/drive/list_folder", { folder: id, limit: 500 }, signal),
    enabled: !!id,
    // Fresh on every visit: coming back from the editor shows the version it saved.
    staleTime: 0,
  });
  const other = useQuery({
    queryKey: ["drive", "view", kind ?? view, query],
    queryFn: ({ signal }) =>
      query || kind
        ? api.get<{ items: Item[] }>("/api/app/drive/search", { query: query || undefined, type: kind, sort: "modified", limit: 200 }, signal)
        : api.get<{ items: Item[] }>(`/api/app/drive/${VIEWS.find((v) => v.id === view)!.action}`, undefined, signal),
    enabled: !inFolder,
    staleTime: 0,
  });
  // An item opened from a link or the bell: shown in its own folder.
  const info = useQuery({
    queryKey: ["drive", "item", selected],
    queryFn: ({ signal }) => api.get<ItemInfo>("/api/app/drive/item_info", { item: selected }, signal),
    enabled: !!selected,
    retry: false,
  });
  useEffect(() => {
    const parent = info.data?.kind === "folder" && !info.data.parent ? info.data.id : info.data?.parent;
    if (selected && inFolder && !folder && parent && parent !== space.data?.root_folder) navigate(`/drive/${parent}?item=${selected}`, { replace: true });
  }, [info.data, selected, inFolder, folder, space.data?.root_folder, navigate]);
  const items = (inFolder ? list.data?.items : other.data?.items) ?? [];
  const present = useFilesPresence(items.filter((i) => i.kind === "file").map((i) => i.id)).data ?? {};
  const refresh = () => qc.invalidateQueries({ queryKey: ["drive"] });
  const act = (action: string, body: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${space.data?.id}/actions/${action}`, body);
  const attempt = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast(done);
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const pick = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p);
  };

  // Uploads go to the shell, which carries on with them in other pages (and other apps) if the
  // person moves on; each shows in the bar's upload tray.
  const upload = async (files: FileList | null) => {
    if (!files?.length || !target) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const { done } = await shell().uploads.start({ file: f, url: `/api/app/drive/upload?${new URLSearchParams({ folder: target, name: f.name })}`, label: f.name });
        done.then(
          () => toast(`Uploaded ${f.name}`),
          (e: unknown) => toast(`${f.name}: ${errorMessage(e)}`, "error"),
        );
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };
  // Finished anywhere (this page, another tab, an earlier page): the lists show it.
  useEffect(() => {
    const off = shell().uploads.on("done", (u) => {
      if (u.app === "drive") void qc.invalidateQueries({ queryKey: ["drive"] });
    });
    return off;
  }, [qc]);

  const create = async (fresh: string) => {
    if (!target) return;
    try {
      const made = await api.post<{ id: string }>("/api/app/drive/new", undefined, { query: { kind: fresh, folder: target } });
      // A live document opens in Docs' editor, another app's page.
      if (fresh === "fdoc") shell().navigate(`/docs/d/${encodeURIComponent(made.id)}`);
      else navigate(`/drive/edit/${encodeURIComponent(made.id)}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  // A file from a template opens in its editor; with none for it, it waits in the list.
  const fromTemplate = (made: { id: string; name: string; size: number | null }) => {
    setGallery(false);
    const open = defaultEditor(editorsFor(made, editors), narrow);
    if (open) return openChoice(open, navigate);
    toast(`Made “${made.name}”`);
    void refresh();
    pick({ item: made.id });
  };
  const newFolder = () =>
    setNaming({ title: "New folder", label: "Name", initial: "", done: (name) => attempt(() => act("create_folder", { parent: id, name }), `Folder “${name}” made`) });
  const rename = (it: Item) =>
    setNaming({
      title: `Rename “${shownName(it.name)}”`,
      label: "New name",
      initial: shownName(it.name),
      // A live document stays one: its name keeps `.fdoc`, which people never see.
      done: (name) => attempt(() => act("rename", { item: it.id, name: isLiveDoc(it.name) ? `${shownName(name)}.fdoc` : name }), "Renamed"),
    });
  const trash = async (it: Item) => {
    if (await confirmDialog({ title: `Move “${shownName(it.name)}” to the trash?`, message: "You can restore it from Trash.", confirmLabel: "Move to trash", danger: true }))
      await attempt(() => act("trash", { item: it.id }), `“${shownName(it.name)}” is in the trash`);
  };
  const destroy = async (it: Item) => {
    if (await confirmDialog({ title: `Delete “${shownName(it.name)}” for good?`, message: "This cannot be undone.", confirmLabel: "Delete forever", danger: true }))
      await attempt(() => act("delete_forever", { item: it.id }), `“${shownName(it.name)}” is deleted`);
  };

  const current = list.data?.folder;
  const title = query ? `Search: ${query}` : kind ? KINDS[kind].title : inFolder ? (current?.name ?? "My files") : VIEWS.find((v) => v.id === view)!.label;
  useEffect(() => shell().title(title), [title]);

  if (space.error || list.error || other.error) {
    return (
      <EmptyState title="Drive is not available" icon="file">
        <p className="muted">{errorMessage(space.error ?? list.error ?? other.error)}</p>
      </EmptyState>
    );
  }
  const ready = inFolder ? !!list.data : !!other.data;
  const canAdd = (inFolder && !!current && allows(current.permission, "Edit")) || (!!kind && !query && !!space.data);

  const fresh = kind ? (KINDS[kind].fresh ? [KINDS[kind].fresh] : []) : NEW.filter((n) => n.kind !== "fdoc" || docs);

  return (
    <div className={selected ? "drive-layout drive-layout-details" : "drive-layout"}>
      <div className="drive-main">
        <FamilyNav className="mb-3" />
        <div className="page-head">
          <div>
            <h1 className="page-title">{title}</h1>
            {inFolder && list.data && list.data.breadcrumbs.length > 1 && (
              <nav className="page-sub" aria-label="Folder path">
                {list.data.breadcrumbs.map((b, i) => (
                  <span key={b.id}>
                    {i > 0 && " / "}
                    <Link to={`/drive/${b.id}`}>{b.name}</Link>
                  </span>
                ))}
              </nav>
            )}
          </div>
          {canAdd && (
            <div className="flex flex-wrap items-center gap-2">
              {kind ? (
                fresh.map((n) => (
                  <span key={n.kind} className="contents">
                    <UiButton size="sm" variant="outline" onClick={() => void create(n.kind)}>
                      <Plus /> {n.label}
                    </UiButton>
                    <UiButton size="sm" variant="outline" onClick={() => setGallery(true)}>
                      <LayoutTemplate /> From a template
                    </UiButton>
                  </span>
                ))
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <UiButton size="sm" variant="outline" aria-label="New document or folder">
                      <Plus /> New
                    </UiButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-52">
                    {fresh.map((n) => (
                      <DropdownMenuItem key={n.kind} onSelect={() => void create(n.kind)}>
                        <FileGlyph kind="file" name={`new.${n.kind}`} size={16} /> {n.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onSelect={() => setGallery(true)}>
                      <LayoutTemplate /> From a template…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={newFolder}>
                      <FolderPlus /> Folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <UiButton size="sm" disabled={busy} onClick={() => picker.current?.click()}>
                <Upload /> Upload
              </UiButton>
              <input ref={picker} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
            </div>
          )}
        </div>
        <div className="drive-bar">
          {!kind && (
            <Tabs
              id={tabsId}
              tabs={VIEWS.map((v) => ({ id: v.id, label: v.label }))}
              value={query ? "" : view}
              onChange={(v) => {
                setTyped("");
                navigate(v === "mine" ? "/drive" : `/drive?view=${v}`);
              }}
            />
          )}
          <form
            role="search"
            className="drive-search"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const q = typed.trim();
              // A kind's page searches within its kind.
              const here = kind ? location.pathname : "/drive";
              navigate(q ? `${here}?q=${encodeURIComponent(q)}` : here);
            }}
          >
            <label htmlFor={`${tabsId}-q`} className="sr-only">
              Search Drive
            </label>
            <input id={`${tabsId}-q`} className="input" type="search" placeholder="Search Drive" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
        </div>
        {!ready ? (
          <Spinner label="Loading files" />
        ) : !items.length ? (
          <EmptyState title={query ? "Nothing matches" : inFolder ? "This folder is empty" : `Nothing in ${title} yet`} icon="file">
            {canAdd && <p className="muted">Upload files or start a document.</p>}
          </EmptyState>
        ) : (
          <Table className="drive-list">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Modified</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => {
                const choices = it.kind === "file" && view !== "trash" ? editorsFor(it, editors) : [];
                const open = defaultEditor(choices, narrow);
                const here = present[it.id] ?? [];
                // Others editing where people edit together: join them there (C2).
                const editing = here.filter((p) => p.mode === "edit");
                const joins = !!open && shared(open.key) && joinable(here);
                const name = shownName(it.name);
                const glyph = <FileGlyph kind={it.kind} name={it.name} />;
                const others = choices.filter((c) => c !== open);
                return (
                  <TableRow key={it.id} data-state={it.id === selected ? "selected" : undefined}>
                    <TableCell className="w-full max-w-0 py-2">
                      <div className="flex min-w-0 items-center gap-3">
                        {it.kind === "folder" && view !== "trash" ? (
                          <Link to={`/drive/${it.id}`} className="drive-name">
                            {glyph}
                            <span className="truncate">{name}</span>
                          </Link>
                        ) : open ? (
                          <EditorLink choice={open} className="drive-name">
                            {glyph}
                            <span className="truncate">{name}</span>
                          </EditorLink>
                        ) : (
                          <span className="drive-name">
                            {glyph}
                            <span className="truncate">{name}</span>
                          </span>
                        )}
                        {it.starred && <Star aria-label="Starred" size={14} className="shrink-0 fill-amber-400 text-amber-400" />}
                        {it.locked_by && <Badge tone="amber">Checked out</Badge>}
                        {here.length > 0 && (
                          <Badge tone="green" title={presenceLabel(here)}>
                            {presenceLabel(here)}
                          </Badge>
                        )}
                      </div>
                      {!inFolder && it.owner && <div className="truncate pl-[30px] text-xs text-muted-foreground">{it.owner}</div>}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                      {formatDateTime(it.modified_at)}
                      {it.modified_by && <span className="hidden lg:inline"> · {it.modified_by}</span>}
                    </TableCell>
                    <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">{sizeLabel(it.size)}</TableCell>
                    <TableCell className="py-1 text-right whitespace-nowrap">
                      {joins && (
                        <EditorLink className={`${buttonVariants({ size: "xs" })} mr-1`} choice={open} aria-label={`Join ${presenceLabel(editing).replace(/ (is|are) editing$/, "")} in ${name}`}>
                          Join
                        </EditorLink>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <UiButton variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="text-muted-foreground">
                            <MoreHorizontal />
                          </UiButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-52">
                          {view === "trash" ? (
                            <>
                              <DropdownMenuItem onSelect={() => void attempt(() => act("restore", { item: it.id }), `“${name}” is restored`)}>
                                <ArchiveRestore /> Restore
                              </DropdownMenuItem>
                              {allows(it.permission, "Manage") && (
                                <DropdownMenuItem variant="destructive" onSelect={() => void destroy(it)}>
                                  <Trash2 /> Delete forever
                                </DropdownMenuItem>
                              )}
                            </>
                          ) : (
                            <>
                              {open && (
                                <DropdownMenuItem onSelect={() => openChoice(open, navigate)}>
                                  <ExternalLink /> {open.key === "live" || open.key === "view" || !allows(it.permission, "Edit") || editing.length > 0 ? "Open" : "Edit online"}
                                </DropdownMenuItem>
                              )}
                              {others.length > 0 && (
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <ExternalLink /> Open with
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="min-w-52">
                                    {others.map((c) => (
                                      <DropdownMenuItem
                                        key={c.key}
                                        onSelect={() => (c.unavailable ? toast(`${c.label} cannot open ${name}: ${c.unavailable}`, "error") : openChoice(c, navigate))}
                                      >
                                        <span className="grid">
                                          {c.label}
                                          {c.unavailable && <span className="text-xs text-muted-foreground">{c.unavailable}</span>}
                                          {!c.unavailable && editing.length > 0 && (
                                            <span className="text-xs text-muted-foreground">
                                              {shared(c.key) && joinable(here) ? `Join ${editing.map((p) => p.name).join(", ")}` : "Read only while others edit"}
                                            </span>
                                          )}
                                        </span>
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                              )}
                              {(open || others.length > 0) && <DropdownMenuSeparator />}
                              <DropdownMenuItem onSelect={() => pick({ item: it.id })}>
                                <Info /> Details
                              </DropdownMenuItem>
                              {allows(it.permission, "Manage") && (
                                <DropdownMenuItem onSelect={() => setSharing(it)}>
                                  <Share2 /> Share
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onSelect={() => void attempt(() => act(it.starred ? "unstar" : "star", { item: it.id }))}>
                                {it.starred ? <StarOff /> : <Star />} {it.starred ? "Remove star" : "Star"}
                              </DropdownMenuItem>
                              {allows(it.permission, "Edit") && (
                                <DropdownMenuItem onSelect={() => rename(it)}>
                                  <Pencil /> Rename
                                </DropdownMenuItem>
                              )}
                              {it.kind === "file" && (
                                <DropdownMenuItem onSelect={() => void download(`/api/app/drive/files/${it.id}/content`, it.name).catch((e) => toast(errorMessage(e), "error"))}>
                                  <Download /> Download
                                </DropdownMenuItem>
                              )}
                              {it.kind === "file" && templatable(it.name) && templates.data?.manage && (
                                <DropdownMenuItem onSelect={() => setSaving(it)}>
                                  <LayoutTemplate /> Save as a template
                                </DropdownMenuItem>
                              )}
                              {allows(it.permission, "Edit") && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem variant="destructive" onSelect={() => void trash(it)}>
                                    <Trash2 /> Move to trash
                                  </DropdownMenuItem>
                                </>
                              )}
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {selected && space.data && <DetailsPanel id={selected} space={space.data.id} onClose={() => pick({ item: null })} onShare={setSharing} />}
      {sharing && space.data && <ShareDialog item={sharing} space={space.data.id} onClose={() => setSharing(null)} />}
      {naming && <NameDialog {...naming} onClose={() => setNaming(null)} />}
      {gallery && target && space.data && (
        <TemplateDialog
          folder={target}
          space={space.data.id}
          only={kind === "Spreadsheet" ? "sheet" : kind === "Presentation" ? "slides" : undefined}
          onMade={fromTemplate}
          onClose={() => setGallery(false)}
        />
      )}
      {saving && space.data && <SaveTemplateDialog file={saving} space={space.data.id} onClose={() => setSaving(null)} />}
    </div>
  );
}

/** Asks for a name (new folder, rename). */
function NameDialog({ title, label, initial, done, onClose }: { title: string; label: string; initial: string; done: (name: string) => Promise<unknown>; onClose: () => void }) {
  const fieldId = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await done(name.trim());
    setBusy(false);
    onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label={label} htmlFor={fieldId}>
          <input id={fieldId} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={255} />
        </Field>
      </form>
    </Dialog>
  );
}

/** `/drive/edit/:file`: the file in the editor server; the page posts the token to the editor's frame. */
export function EditPage() {
  const { file } = useParams();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the editor tells: who is in the file (null until it says), unsaved changes.
  const [views, setViews] = useState<EditorView[] | null>(null);
  const [modified, setModified] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<"comments" | "versions" | null>(null);
  const [sharing, setSharing] = useState<Shareable | null>(null);
  const space = useQuery({
    queryKey: ["drive", "space"],
    queryFn: ({ signal }) => api.get<{ id: string; root_folder: string }>("/api/app/drive/space", undefined, signal),
  });
  const leave = () => ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate("/drive"));

  useEffect(() => {
    let live = true;
    api.post<Launch>(`/api/app/drive/editor/${file}`).then(
      (l) => live && setLaunch(l),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [file]);
  useEffect(() => {
    if (launch) form.current?.submit();
  }, [launch]);
  // The editor's messages (Ferrum docs/plan/collaboration.md, C2): only from its own frame and origin.
  useEffect(() => {
    if (!launch || !file) return;
    const origin = new URL(launch.url, location.href).origin;
    const post = (id: string) => frame.current?.contentWindow?.postMessage(hostMessage(id), origin);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const m = parseMessage(e.data);
      if (!m) return;
      switch (m.id) {
        case "App_LoadingStatus": {
          const status = (m.values as { Status?: string } | null)?.Status;
          if (status === "Frame_Ready") post("Host_PostmessageReady");
          if (status === "Document_Loaded") post("Get_Views");
          break;
        }
        case "View_Added":
        case "View_Removed":
        case "Get_Views_Resp":
        case "Views_List":
          setViews((v) => applyViews(v, m));
          break;
        case "Doc_ModifiedStatus":
          setModified((m.values as { Modified?: unknown } | null)?.Modified === true);
          break;
        // Its Share and version history buttons open Drive's own.
        case "UI_Share":
        case "UI_Sharing":
          setSharing({ id: file, name: launch.name, kind: "file" });
          break;
        case "UI_FileVersions":
          setPanel("versions");
          break;
        case "UI_Close":
          leave();
          break;
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [launch, file]);
  // Drive's lists show who has the file open; the editor names who is in it, when it says.
  const present = usePresence(file, launch ? (launch.action === "edit" ? "edit" : "view") : null);
  const others = views ? othersOf(views) : null;
  // Whoever edits it in a browser editor holds it, and the editor here only shows it meanwhile.
  const elsewhere = present.filter((p) => p.editor === "browser");

  if (error) {
    return (
      <EmptyState title="This file cannot be opened online" icon="file">
        <p className="muted">{error}</p>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </EmptyState>
    );
  }
  if (!launch || !file) return <Spinner label="Opening the editor" />;
  return (
    <div className="editor-page">
      <div className="editor-bar">
        <Button size="sm" icon="left" onClick={leave}>
          Back
        </Button>
        <strong>{launch.name}</strong>
        {launch.action === "view" && <Badge>Read only</Badge>}
        {others ? (
          others.length > 0 && (
            <span className="editor-people" role="group" aria-label={`Also in the file: ${others.map((v) => v.name + (v.readOnly ? " (viewing)" : "")).join(", ")}`}>
              {others.slice(0, 6).map((v) => (
                <span key={v.id} className="editor-person" style={{ background: v.color, color: inkOn(v.color) }} title={v.readOnly ? `${v.name} (viewing)` : v.name} aria-hidden>
                  {initials(v.name)}
                </span>
              ))}
              {others.length > 6 && (
                <span className="editor-person editor-person-more" aria-hidden>
                  +{others.length - 6}
                </span>
              )}
            </span>
          )
        ) : (
          present.length > 0 && <Badge tone="green">{presenceLabel(present)}</Badge>
        )}
        {others && elsewhere.length > 0 && <Badge tone="amber">{presenceLabel(elsewhere)} in a browser editor</Badge>}
        {launch.action === "edit" && (
          <span className="faint" role="status">
            {modified === true ? "Unsaved changes" : modified === false ? "All changes saved" : "Changes are saved as new versions in Drive."}
          </span>
        )}
        <span className="editor-bar-end">
          <Button size="sm" aria-pressed={!!panel} onClick={() => setPanel(panel ? null : "comments")}>
            Comments and history
          </Button>
        </span>
      </div>
      <form ref={form} action={launch.url} method="post" target="office-editor" hidden>
        <input type="hidden" name="access_token" value={launch.access_token} />
        <input type="hidden" name="access_token_ttl" value={String(launch.access_token_ttl)} />
      </form>
      <div className={panel ? "editor-main editor-main-details" : "editor-main"}>
        <iframe ref={frame} name="office-editor" title={`${launch.name} in the editor`} className="editor-frame" allow="clipboard-read; clipboard-write; fullscreen" />
        {panel && space.data && <DetailsPanel id={file} space={space.data.id} tab={panel} inEditor onClose={() => setPanel(null)} onShare={setSharing} />}
      </div>
      {sharing && space.data && <ShareDialog item={sharing} space={space.data.id} onClose={() => setSharing(null)} />}
    </div>
  );
}
