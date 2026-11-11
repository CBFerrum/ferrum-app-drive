// Drive (the drive app's /api/app/drive endpoints): the person's files in a folder, with the places
// they come from beside it (My files, what is shared with them, recent, starred, the trash and the
// team folders they belong to), and search; Sheets, Slides and PDF (Drive's files of one kind).
// Long folders load as the person scrolls. Several items are chosen to act on all of them; items
// move by dragging onto a folder (or from a menu and a destination picker); files and folders are
// uploaded by dropping them on the page (handed to the shell, so it goes on in other apps' pages).
// A file opens in a preview over the list (Preview.tsx: images, video, audio, PDFs, text, tables,
// code, documents) with the arrow keys going through the folder; the list can be cards instead of
// rows (FileGrid.tsx). Moving, trashing and renaming say what they did and can be undone (Undo.tsx).
// New folders and files, or ones from a template; sharing, comments, versions and activity in a
// panel beside the list; who has a file open now (presence.ts). Files open in the editor server the
// operator runs (Collabora Online or ONLYOFFICE, over WOPI), in a browser editor an add-on offers
// (BrowserEdit.tsx), or, for documents edited live, in Docs' editor (another app's page).

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, FileUp, FolderPlus, FolderUp, HardDrive, LayoutGrid, LayoutTemplate, List, Plus, Trash2, Upload } from "lucide-react";
import { type DragEvent, type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, errorMessage, shell, t as tr, isolate } from "@ferrum/client";
import { Button, FamilyNav, ListSkeleton, Spinner, StatePanel, toast, useShellTitle } from "@ferrum/kit";
import {
  Button as UiButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ferrum/kit/primitives";
import { Chips, type SetQuery } from "./Chips";
import { type Choice, clashes } from "./clash";
import { type Carried, bringsFiles, dragged } from "./drag";
import { type DropApi, DropContext, type DropTarget, useDropTarget } from "./dropping";
import { type Entry, type Tree, entriesOf, fromPicker, walk } from "./dropped";
import { openChoice, useDocs, useEditors } from "./editors";
import { FileGlyph } from "./FileGlyph";
import { FileList } from "./FileList";
import type { RowActions } from "./ItemMenu";
import { type Item, type Shareable, allows, problemKind, defaultEditor, editorsFor, sizeLabel } from "./files";
import { BulkBar, BulkShareDialog, ClashDialog, DetailsPanel, FileGrid, Later, LaterBulk, LaterGrid, LaterPanel, LaterPreview, MoveDialog, NameDialog, NewTeamDialog, Preview, SaveTemplateDialog, ShareDialog, ShortcutsDialog, TeamDialog, TemplateDialog } from "./later";
import { VIEWS, abilities, defaultSort, emptyText, filtersOn, naturalOrder, readQuery, shownOf, sourceOf, viewOf } from "./listing";
import { useFilesPresence } from "./presence";
import { Rail, type Place } from "./Rail";
import { NOTHING, type Chosen, all as chooseEvery, click, keep } from "./selection";
import { commandFor, typing } from "./shortcuts";
import { useTemplates } from "./templateList";
import { useUndo } from "./Undo";
import { useActions } from "./useActions";
import { useFolder, useFresh, useListing, useSpace, useUsage } from "./useDrive";

/** How the list is drawn: rows or cards. A convenience of this browser, nothing shared. */
const LAYOUT = "drive.layout";
const savedLayout = (): "list" | "grid" => {
  try {
    return localStorage.getItem(LAYOUT) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
};

/** New files: a live document always; office files open in the online or a browser editor. */
const NEW = [
  { kind: "fdoc", get label() { return tr("Document"); } },
  { kind: "docx", get label() { return tr("Word document"); } },
  { kind: "xlsx", get label() { return tr("Spreadsheet"); } },
  { kind: "pptx", get label() { return tr("Presentation"); } },
] as const;

/** Drive's launcher entries for one kind of file (`/sheets/`, `/slides/`, `/pdf/`): everything of
 *  that kind the person can see, and a New button for it. */
export const KINDS = {
  Spreadsheet: { get title() { return tr("Sheets"); }, noun: "spreadsheets", fresh: { kind: "xlsx", get label() { return tr("New spreadsheet"); } } },
  Presentation: { get title() { return tr("Slides"); }, noun: "presentations", fresh: { kind: "pptx", get label() { return tr("New presentation"); } } },
  PDF: { get title() { return tr("PDF"); }, get noun() { return tr("PDFs"); }, fresh: null },
} as const;
export type FileKind = keyof typeof KINDS;

/** One step of the folder path above the list; a folder in it takes drops. */
function Crumb({ id, name, last }: { id: string; name: string; last: boolean }) {
  const drop = useDropTarget(last ? null : { id, name });
  return last ? (
    <span aria-current="location">{isolate(name)}</span>
  ) : (
    <Link to={`/drive/${id}`} className="drive-crumb" data-over={drop.over || undefined} {...drop.props}>
      {isolate(name)}
    </Link>
  );
}

/** Under the list: how many are shown, and the rest coming as the person scrolls (or at a press). */
function More({ shown, total, hasMore, loading, load }: { shown: number; total: number | null; hasMore: boolean; loading: boolean; load: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver((seen) => seen[0]?.isIntersecting && load(), { rootMargin: "600px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [hasMore, loading, shown, load]);
  return (
    <div ref={end} className="drive-more">
      <span className="faint" role="status">
        {hasMore ? tr("Showing {shown}", { shown: shownOf(shown, total) }) : shown === 1 ? tr("1 item") : tr("{shown} items", { shown: shown.toLocaleString() })}
      </span>
      {hasMore && (
        <UiButton size="sm" variant="outline" disabled={loading} onClick={load}>
          {loading ? tr("Loading…") : tr("Show more")}
        </UiButton>
      )}
    </div>
  );
}

/** `/drive/:folder?`: a folder of your Drive (your space's top folder by default), or with `?view=`
 *  another view, with `?q=` a search, with `?item=` an item's details beside the list, and with
 *  `?sort=`, `?order=`, `?type=`, `?since=` and `?owner=` the sort and filters; with `kind`, every
 *  file of one kind (Sheets, Slides, PDF). */
export function DrivePage({ kind }: { kind?: FileKind }) {
  const { folder } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const railId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const shellBox = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState<Shareable | null>(null);
  const [sharingMany, setSharingMany] = useState<Item[] | null>(null);
  const [moving, setMoving] = useState<{ items: Item[]; copy: boolean } | null>(null);
  const [naming, setNaming] = useState<{ title: string; label: string; initial: string; done: (name: string) => Promise<unknown> } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<"list" | "grid">(savedLayout);
  const [asking, setAsking] = useState<{ names: string[]; tree: Tree; to: DropTarget; taken: ReadonlySet<string> } | null>(null);
  const [choosingPlace, setChoosingPlace] = useState(false);
  const [versionFor, setVersionFor] = useState<Item | null>(null);
  const versionPicker = useRef<HTMLInputElement>(null);
  const clipboard = useRef<{ items: Item[]; cut: boolean } | null>(null);
  const undo = useUndo();
  const [gallery, setGallery] = useState(false);
  const [saving, setSaving] = useState<Item | null>(null);
  const [helping, setHelping] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(false);
  const [places, setPlaces] = useState(false);
  const [chosen, setChosen] = useState<Chosen>(NOTHING);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [carrying, setCarrying] = useState<Carried[] | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);

  const view = viewOf(params.get("view"));
  const query = params.get("q") ?? "";
  const selected = params.get("item");
  const previewId = params.get("preview");
  const q = useMemo(() => readQuery(params), [params]);
  const [typed, setTyped] = useState(query);
  // Leaving a search by any other way (a place in the rail, the back button) empties the box.
  useEffect(() => setTyped(query), [query]);
  const space = useSpace();
  const usage = useUsage();
  const root = space.data?.root_folder;
  const inFolder = view === "mine" && !query && !kind;
  const id = inFolder ? (folder ?? root) : undefined;
  // Where uploads and new files go: this folder, else your top folder.
  const target = id ?? root;
  const head = useFolder(id);
  const src = useMemo(() => sourceOf({ view: kind ? "mine" : view, folder: id, query, fileType: kind, q }), [kind, view, id, query, q]);
  const list = useListing(src, q);
  const docs = useDocs();
  const found = useEditors();
  const editors = useMemo(() => ({ online: found.online, browser: found.browser, docs }), [found.online, found.browser, docs]);
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
  const templates = useTemplates();
  useFresh();

  const items = useMemo(() => list.items.filter((i) => !hidden.has(i.id)), [list.items, hidden]);
  // Cards come as folders, then files; the keys go through them in that order.
  const ordered = useMemo(() => (layout === "grid" ? [...items.filter((i) => i.kind === "folder"), ...items.filter((i) => i.kind === "file")] : items), [items, layout]);
  const ids = useMemo(() => ordered.map((i) => i.id), [ordered]);
  const previewable = useMemo(() => (view === "trash" ? [] : ordered.filter((i) => i.kind === "file")), [ordered, view]);
  const setLayout = (next: "list" | "grid") => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT, next);
    } catch {
      // Not kept in this browser; it still changes here.
    }
  };
  const present = useFilesPresence(items.filter((i) => i.kind === "file").map((i) => i.id)).data ?? {};
  const chosenItems = useMemo(() => items.filter((i) => chosen.selected.has(i.id)), [items, chosen]);
  const current = head.data;
  const listKey = JSON.stringify([src, kind]);
  useEffect(() => setChosen(NOTHING), [listKey]);
  useEffect(() => setChosen((c) => keep(c, ids)), [ids]);
  useEffect(() => setPlaces(false), [folder, view, query, kind]);

  // An item opened from a link or the bell: shown in its own folder.
  const within = useFolder(q.within ?? undefined);
  const info = useFolder(selected ?? undefined);
  useEffect(() => {
    const parent = info.data?.kind === "folder" && !info.data.parent ? info.data.id : info.data?.parent;
    if (selected && inFolder && !folder && parent && parent !== root) navigate(`/drive/${parent}?item=${selected}`, { replace: true });
  }, [info.data, selected, inFolder, folder, root, navigate]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["drive"] }), [qc]);
  const pick = useCallback(
    (next: Record<string, string | null>) => {
      const p = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      setParams(p);
    },
    [params, setParams],
  );
  const setQuery: SetQuery = (next) => pick(next);
  const hide = (these: string[]) => setHidden((h) => new Set([...h, ...these]));
  const show = (these: string[]) =>
    setHidden((h) => {
      const left = new Set(h);
      these.forEach((i) => left.delete(i));
      return left;
    });
  const actions = useActions({ space: space.data?.id, hide, show, after: refresh, most: usage.data?.limits.max_upload_bytes ?? null, carries: usage.data?.limits.request_bytes ?? null, offer: undo.give });

  // Finished anywhere (this page, another tab, an earlier page): the lists show it.
  useEffect(() => shell().uploads.on("done", (u) => void (u.app === "drive" && qc.invalidateQueries({ queryKey: ["drive"] }))), [qc]);

  const title = query ? tr("Search: {query}", { query }) : kind ? KINDS[kind].title : inFolder ? (id === root ? tr("My files") : (current?.name ?? tr("Drive"))) : VIEWS.find((v) => v.id === view)!.label;
  useShellTitle(title);
  const canAdd = (inFolder && !!current && allows(current.permission, "Edit")) || (!!kind && !query && !!space.data);
  const targetName = !target || target === root ? tr("My files") : (current?.name ?? "this folder");
  // A folder in someone else's space belongs to what is shared with the person, not to their own files.
  const others = !!current?.owner && !!usage.data && current.owner.toLowerCase() !== usage.data.space.owner.toLowerCase();
  const place: Place = kind || query ? null : inFolder ? (current?.team ? { team: current.team } : others ? "shared" : "mine") : view;
  const can = abilities(src, kind);
  const sort = q.sort ?? defaultSort(src);
  const order = q.order ?? (sort ? naturalOrder(sort) : "asc");
  const filtered = filtersOn(q) > 0;
  const crumbs = inFolder && current?.breadcrumbs && current.breadcrumbs.length > 1 ? current.breadcrumbs : [];

  const attempt = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast(done);
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  /** A file just made opens in its editor; with none for it, it waits in the list. */
  const openMade = (made: { id: string; name: string; size: number | null }) => {
    setGallery(false);
    const open = defaultEditor(editorsFor(made, editors), narrow);
    if (open) return openChoice(open, navigate);
    toast(tr("Made “{name}”", { name: made.name }));
    void refresh();
    pick({ item: made.id });
  };
  const create = async (fresh: string) => {
    if (!target || !space.data) return;
    try {
      openMade(await api.post<{ id: string; name: string; size: number | null }>("/api/app/drive/new", undefined, { query: { kind: fresh, folder: target } }));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const newFolder = () =>
    setNaming({ title: tr("New folder"), label: tr("Name"), initial: "", done: (name) => attempt(() => actions.act("create_folder", { parent: id, name }), tr("Folder “{name}” made", { name })) });
  /** A new version of a file, once the person has seen what it will do. */
  const newVersionOf = async (file: Item, content: File) => {
    setVersionFor(null);
    if (await (await import("./versionUpload")).addVersion(file, content, { most: usage.data?.limits.max_upload_bytes, carries: usage.data?.limits.request_bytes })) await refresh();
  };
  /** The preview of a file: the address keeps the page's other settings. */
  const previewTo = (it: Item) => {
    const p = new URLSearchParams(params);
    p.set("preview", it.id);
    return { search: `?${p}` };
  };
  const openItem = (it: Item) => {
    if (it.kind === "folder") return navigate(`/drive/${it.id}`);
    navigate(previewTo(it));
  };
  /** Closes the preview (it puts the focus back on the item it ended on). */
  const closePreview = () => pick({ preview: null });
  const stopRenaming = () => {
    const was = renaming;
    setRenaming(null);
    setTimeout(() => was && document.querySelector<HTMLElement>(`[data-row="${CSS.escape(was)}"]`)?.focus(), 0);
  };

  /** Uploads what was dropped or chosen into a folder; `read` finds the files and folders. A file whose name is taken there is asked about first. */
  const uploadTo = async (read: () => Promise<Tree> | Tree, to: DropTarget) => {
    setBusy(true);
    try {
      const tree = await read();
      const loose = tree.files.some((f) => f.path.length === 0);
      let taken: ReadonlySet<string> = new Set();
      let compared = true;
      if (loose) {
        try {
          const r = await actions.names(to.id);
          taken = r.names;
          compared = r.complete;
        } catch {
          compared = false;
        }
      }
      if (loose && !compared) toast(tr("Some of these files may share a name with ones in “{name}”: this folder is too big to compare, so they are kept side by side.", { name: to.name }), "info");
      const same = clashes(tree.files, taken);
      if (same.length) return setAsking({ names: same.map((f) => f.file.name), tree, to, taken });
      await actions.upload(tree, to);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  /** The answers to the questions about taken names: skipped files leave, the rest go with what was said. */
  const answered = async (choices: Map<string, Choice>) => {
    if (!asking) return;
    const { tree, to } = asking;
    setAsking(null);
    const skipped = tree.files.filter((f) => f.path.length === 0 && choices.get(f.file.name.trim().toLowerCase()) === "skip");
    setBusy(true);
    try {
      await actions.upload({ ...tree, files: tree.files.filter((f) => !skipped.includes(f)) }, to, choices, skipped.length);
    } finally {
      setBusy(false);
    }
  };
  const dropFiles = (entries: Entry[], to: DropTarget) => {
    depth.current = 0;
    setDropping(false);
    if (entries.length) void uploadTo(() => walk(entries), to);
  };
  const chosenFiles = (files: FileList | null, folderPick: boolean) => {
    if (!files?.length || !target) return;
    const list = Array.from(files);
    void uploadTo(() => (folderPick ? fromPicker(list) : { dirs: [], files: list.map((file) => ({ path: [], file })) }), { id: target, name: targetName });
  };

  const dropApi: DropApi = {
    carrying,
    over,
    setOver,
    items: (list, to, copy) => {
      const these = items.filter((i) => list.some((c) => c.id === i.id));
      setCarrying(null);
      void actions.move(these, to, copy);
    },
    files: dropFiles,
  };
  const rows: RowActions = {
    open: openItem,
    previewTo,
    details: (it) => pick({ item: it.id }),
    share: setSharing,
    star: (it) => void actions.star([it]),
    rename: (it) => setRenaming(it.id),
    renameTo: async (it, name) => {
      const why = await actions.rename(it, name);
      if (!why) stopRenaming();
      return why;
    },
    stopRenaming,
    move: (it, copy) => setMoving({ items: [it], copy }),
    download: (it) => void actions.download([it]),
    newVersion: (it) => (setVersionFor(it), versionPicker.current?.click()),
    trash: (it) => void actions.trash([it]),
    restore: (it) => void actions.restore([it]),
    destroy: (it) => void actions.destroy([it]),
    saveTemplate: setSaving,
    navigate: (to) => navigate(to),
    choose: (row, shift) => setChosen((c) => click(c, ids, row, shift)),
    chooseAll: (on) => setChosen(on ? chooseEvery(ids) : NOTHING),
    dragStart: (row) => {
      const picked = dragged(row, chosen.selected, items).map(({ id: i, kind: k, name, parent }) => ({ id: i, kind: k, name, parent }));
      // Not in this event: changing the page as a drag starts can end the drag.
      setTimeout(() => setCarrying(picked), 0);
      return picked;
    },
    dragEnd: () => {
      setCarrying(null);
      setOver(null);
    },
  };

  // Keys. The handler is the latest render's; the listener is put up once. The commands themselves
  // (keyboard.ts) are loaded after the page has drawn.
  const keys = useRef<(e: KeyboardEvent) => void>(undefined);
  const commands = useRef<typeof import("./keyboard").runCommand>(undefined);
  useEffect(() => void import("./keyboard").then((m) => (commands.current = m.runCommand)), []);
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // Fields, menus and dialogs keep their keys; so does the bar (its own tree) and anything outside the page.
    if (typing(e.composedPath()[0] ?? e.target)) return;
    const at = e.target as Element;
    if (at !== document.body && !at.closest?.("#main")) return;
    const command = commandFor(e);
    if (!command || !commands.current) return;
    commands.current(e, command, {
      items,
      ids,
      chosen,
      view,
      layout,
      places,
      selected,
      canAdd,
      target,
      targetName,
      clipboard,
      actions,
      openItem,
      pick,
      newFolder,
      focusSearch: () => searchBox.current?.focus(),
      chooseUpload: () => picker.current?.click(),
      setHelping,
      setChosen,
      setPlaces,
      setRenaming,
      setMoving,
      setSharing,
      setSharingMany,
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current?.(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // A file dropped where nothing takes it would be opened by the browser, in place of this page.
  useEffect(() => {
    const keepPage = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer || !bringsFiles(e.dataTransfer.types)) return;
      e.preventDefault();
      if (!shellBox.current?.contains(e.target as Node)) e.dataTransfer.dropEffect = "none";
    };
    addEventListener("dragover", keepPage);
    addEventListener("drop", keepPage);
    return () => {
      removeEventListener("dragover", keepPage);
      removeEventListener("drop", keepPage);
    };
  }, []);

  /** Files from the computer over the page: the whole page says it takes them. */
  const overPage = {
    onDragEnter: (e: DragEvent) => {
      if (!bringsFiles(e.dataTransfer.types)) return;
      depth.current++;
      setDropping(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!bringsFiles(e.dataTransfer.types)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDropping(false);
    },
    onDragOver: (e: DragEvent) => {
      if (!bringsFiles(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = canAdd ? "copy" : "none";
    },
    onDrop: (e: DragEvent) => {
      if (!bringsFiles(e.dataTransfer.types)) return;
      e.preventDefault();
      if (!canAdd || !target) {
        depth.current = 0;
        setDropping(false);
        return toast(tr("You cannot add files here"), "error");
      }
      dropFiles(entriesOf(e.dataTransfer), { id: target, name: targetName });
    },
  };

  const empty = emptyText({ view, query, filtered, canAdd, kind: kind ? KINDS[kind].noun : undefined, trashDays: usage.data?.limits.trash_days });
  const fresh = kind ? (KINDS[kind].fresh ? [KINDS[kind].fresh] : []) : NEW.filter((n) => n.kind !== "fdoc" || docs);
  const problem = space.error ?? head.error ?? list.error;
  const waiting = list.loading || (space.isPending && !src);

  const body = problem ? (
    // Denied is not empty and offline is not broken: each says what it is, and none says what exists.
    <StatePanel kind={problemKind(problem)} title={tr("Drive could not show this")} error={problem} onRetry={() => void qc.invalidateQueries({ queryKey: ["drive"] })} />
  ) : waiting ? (
    layout === "grid" ? (
      <div className="drive-grid" role="status" aria-label={tr("Loading…")}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="drive-card drive-card-skeleton" aria-hidden="true" />
        ))}
      </div>
    ) : (
      <ListSkeleton rows={7} />
    )
  ) : !items.length ? (
    <StatePanel
      kind={query || filtered ? "no-matches" : "empty"}
      title={empty.title}
      action={query ? <Button onClick={() => navigate(kind ? location.pathname : "/drive")}>{tr("Clear the search")}</Button> : undefined}
      onClear={!query && filtered ? () => setQuery({ type: null, since: null, owner: null, in: null }) : undefined}
    >
      {isolate(empty.hint)}
    </StatePanel>
  ) : (
    <>
      {view === "trash" && (
        <p className="faint drive-note" role="note">
          {usage.data ? tr("Items in the trash are deleted for good {value} days after they were moved there. Restore one before then to keep it.", { value: usage.data.limits.trash_days }) : ""}
        </p>
      )}
      {layout === "grid" ? (
        <LaterGrid>
          <FileGrid items={items} view={view} chosen={chosen.selected} shown={selected} present={present} editors={editors} narrow={narrow} templates={!!templates.data?.manage} renaming={renaming} actions={rows} />
        </LaterGrid>
      ) : (
        <FileList
          items={items}
          view={view}
          inFolder={inFolder && !filtered}
          chosen={chosen.selected}
          shown={selected}
          present={present}
          editors={editors}
          narrow={narrow}
          templates={!!templates.data?.manage}
          renaming={renaming}
          sort={sort}
          order={order}
          sortable={can.sorts}
          onSort={(key) => setQuery({ sort: key, order: key === sort ? (order === "asc" ? "desc" : "asc") : null })}
          actions={rows}
        />
      )}
      <More shown={items.length} total={list.total} hasMore={list.hasMore} loading={list.loadingMore} load={list.loadMore} />
    </>
  );

  return (
    <DropContext.Provider value={dropApi}>
      <div ref={shellBox} className="drive-shell" data-details={selected ? "" : undefined} {...overPage}>
          <input
            ref={versionPicker}
            type="file"
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const chosenFile = e.target.files?.[0];
              e.target.value = "";
              if (chosenFile && versionFor) void newVersionOf(versionFor, chosenFile);
            }}
          />
        <Rail
          id={railId}
          className={places ? "is-open" : undefined}
          place={place}
          usage={usage.data}
          loading={usage.isPending}
          root={root}
          onPick={() => setPlaces(false)}
          onManage={(t) => setManaging(t.id)}
          onNewTeam={() => setNewTeam(true)}
        />
        <div className="drive-main">
          <FamilyNav className="mb-3" />
          <div className="page-head">
            <div className="drive-title">
              <h1 className="page-title">{isolate(title)}</h1>
              {crumbs.length > 0 && (
                <nav className="page-sub drive-crumbs" aria-label={tr("Folder path")}>
                  {crumbs.map((b, i) => (
                    <span key={b.id}>
                      {i > 0 && <span aria-hidden="true"> / </span>}
                      <Crumb id={b.id} name={b.id === root ? "My files" : b.name} last={i === crumbs.length - 1} />
                    </span>
                  ))}
                </nav>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="drive-places-toggle" aria-expanded={places} aria-controls={railId} onClick={() => setPlaces(!places)}>
                <HardDrive aria-hidden size={14} /> {tr("Places")}
              </button>
              {canAdd && (
                <>
                  {kind ? (
                    fresh.map((n) => (
                      <span key={n.kind} className="contents">
                        <UiButton size="sm" variant="outline" onClick={() => void create(n.kind)}>
                          <Plus /> {isolate(n.label)}
                        </UiButton>
                        <UiButton size="sm" variant="outline" onClick={() => setGallery(true)}>
                          <LayoutTemplate /> {tr("From a template")}
                        </UiButton>
                      </span>
                    ))
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <UiButton size="sm" variant="outline" aria-label={tr("New document or folder")}>
                          <Plus /> {tr("New")}
                        </UiButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-52">
                        {fresh.map((n) => (
                          <DropdownMenuItem key={n.kind} onSelect={() => void create(n.kind)}>
                            <FileGlyph kind="file" name={`new.${n.kind}`} size={16} /> {isolate(n.label)}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem onSelect={() => setGallery(true)}>
                          <LayoutTemplate /> {tr("From a template…")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={newFolder}>
                          <FolderPlus /> {tr("Folder")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiButton size="sm" disabled={busy}>
                        {busy ? <Spinner small /> : <Upload />} {tr("Upload")} <ChevronDown />
                      </UiButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-44">
                      <DropdownMenuItem onSelect={() => picker.current?.click()}>
                        <FileUp /> {tr("Files…")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => folderPicker.current?.click()}>
                        <FolderUp /> {tr("Folder…")}
                      </DropdownMenuItem>
                      {usage.data && (
                        <>
                          <DropdownMenuSeparator />
                          <p className="drive-menu-note">{tr("Up to {size} for each file", { size: sizeLabel(usage.data.limits.max_upload_bytes) })}</p>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <input ref={picker} type="file" multiple hidden aria-hidden tabIndex={-1} onChange={(e) => (chosenFiles(e.target.files, false), (e.target.value = ""))} />
                  <input
                    ref={folderPicker}
                    type="file"
                    hidden
                    aria-hidden
                    tabIndex={-1}
                    {...{ webkitdirectory: "" }}
                    onChange={(e) => (chosenFiles(e.target.files, true), (e.target.value = ""))}
                  />
                </>
              )}
              {view === "trash" && !query && items.length > 0 && (
                <UiButton size="sm" variant="outline" onClick={() => void actions.emptyTrash(list.total ?? items.length)}>
                  <Trash2 /> {tr("Empty the trash")}
                </UiButton>
              )}
              <div className="drive-layout" role="group" aria-label={tr("How to show the files")}>
                <UiButton variant={layout === "list" ? "secondary" : "ghost"} size="icon-sm" aria-label={tr("List")} aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
                  <List />
                </UiButton>
                <UiButton variant={layout === "grid" ? "secondary" : "ghost"} size="icon-sm" aria-label={tr("Grid")} aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>
                  <LayoutGrid />
                </UiButton>
              </div>
            </div>
          </div>
          <div className="drive-bar">
            <form
              role="search"
              className="drive-search"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                const word = typed.trim();
                // A kind's page searches within its kind.
                const here = kind ? location.pathname : "/drive";
                navigate(word ? `${here}?q=${encodeURIComponent(word)}` : here);
              }}
            >
              <label htmlFor={`${railId}-q`} className="sr-only">
                {tr("Search Drive")}
              </label>
              <input ref={searchBox} id={`${railId}-q`} className="input" type="search" placeholder={tr("Search Drive")} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </form>
            <Chips src={src} fileType={kind} q={q} set={setQuery} location={query || kind ? { name: within.data?.name ?? null, choose: () => setChoosingPlace(true) } : null} />
          </div>
          {query && (
            <p className="faint drive-note" role="note">
              {tr("Searching the names of files and folders, and the words inside Ferrum documents. The words inside other files are not searched.")}
            </p>
          )}
          {src?.kind === "search" && src.folder && !query && (
            <p className="faint drive-note" role="status">
              {tr("Looking in “{targetName}” and the folders inside it.", { targetName })}
            </p>
          )}
          {chosenItems.length > 0 && (
            <LaterBulk>
              <BulkBar
                chosen={chosenItems}
                trash={view === "trash"}
                actions={{
                  move: (copy) => setMoving({ items: chosenItems, copy }),
                  share: () => (chosenItems.length === 1 ? setSharing(chosenItems[0]) : setSharingMany(chosenItems)),
                  download: () => void actions.download(chosenItems),
                  trash: () => void actions.trash(chosenItems),
                  restore: () => void actions.restore(chosenItems),
                  destroy: () => void actions.destroy(chosenItems),
                  clear: () => setChosen(NOTHING),
                }}
              />
            </LaterBulk>
          )}
          {body}
        </div>
        {selected && space.data && (
          <LaterPanel>
            <DetailsPanel id={selected} space={space.data.id} onClose={() => pick({ item: null })} onShare={setSharing} />
          </LaterPanel>
        )}
        {dropping && (
          <div className="drive-drop" aria-hidden="true" data-blocked={!canAdd || undefined}>
            <div>
              {canAdd ? tr("Drop files or folders to upload them to “{targetName}”", { targetName }) : tr("You cannot add files here")}
              {canAdd && usage.data && <span className="drive-drop-limit">{tr("Up to {size} for each file", { size: sizeLabel(usage.data.limits.max_upload_bytes) })}</span>}
            </div>
          </div>
        )}
      </div>
      <Later>
        {sharing && space.data && (
          <ShareDialog
            item={sharing}
            space={space.data.id}
            onClose={() => setSharing(null)}
            onOpenFolder={(f) => {
              setSharing(null);
              navigate(`/drive/${f}`);
            }}
          />
        )}
        {sharingMany && space.data && <BulkShareDialog items={sharingMany} space={space.data.id} onClose={() => setSharingMany(null)} onDone={(failed) => setChosen(failed.length ? { selected: new Set(failed.map((f) => f.id)), anchor: null } : NOTHING)} />}
        {moving && root && (
          <MoveDialog
            items={moving.items}
            copy={moving.copy}
            start={inFolder ? (id ?? null) : null}
            root={root}
            usage={usage.data}
            onClose={() => setMoving(null)}
            onChoose={(to) => {
              const { items: these, copy } = moving;
              setMoving(null);
              setChosen(NOTHING);
              void actions.move(these, to, copy);
            }}
          />
        )}
        {helping && <ShortcutsDialog onClose={() => setHelping(false)} />}
        {managing && space.data && <TeamDialog team={managing} space={space.data.id} onClose={() => setManaging(null)} />}
        {newTeam && space.data && (
          <NewTeamDialog
            space={space.data.id}
            onClose={() => setNewTeam(false)}
            onMade={(f) => {
              setNewTeam(false);
              navigate(`/drive/${f}`);
            }}
          />
        )}
        {gallery && target && space.data && (
          <TemplateDialog folder={target} space={space.data.id} only={kind === "Spreadsheet" ? "sheet" : kind === "Presentation" ? "slides" : undefined} onMade={openMade} onClose={() => setGallery(false)} />
        )}
        {saving && space.data && <SaveTemplateDialog file={saving} space={space.data.id} onClose={() => setSaving(null)} />}
      </Later>
      {previewId && (
        <LaterPreview>
          <Preview
            id={previewId}
            files={previewable}
            editors={editors}
            narrow={narrow}
            admin={!!usage.data?.admin}
            onClose={closePreview}
            onGo={(next) => navigate({ search: (() => { const p = new URLSearchParams(params); p.set("preview", next); return `?${p}`; })() }, { replace: true })}
            onDownload={(it) => void actions.download([it])}
            onShare={(it) => (pick({ preview: null }), setSharing(it))}
            onDetails={(it) => pick({ preview: null, item: it.id })}
          />
        </LaterPreview>
      )}
      {asking && (
        <Later>
          <ClashDialog names={asking.names} folder={asking.to.name} onDone={(choices) => void answered(choices)} onCancel={() => (setAsking(null), toast(tr("Nothing was uploaded"), "info"))} />
        </Later>
      )}
      {choosingPlace && root && (
        <Later>
          <MoveDialog
            items={[]}
            copy={false}
            start={inFolder ? (id ?? null) : null}
            root={root}
            usage={usage.data}
            pick={{ title: tr("Search in a folder"), button: tr("Search here") }}
            onClose={() => setChoosingPlace(false)}
            onChoose={(to) => (setChoosingPlace(false), setQuery({ in: to.id }))}
          />
        </Later>
      )}
      {undo.host}
      {naming && (
        <Later>
          <NameDialog {...naming} onClose={() => setNaming(null)} />
        </Later>
      )}
    </DropContext.Provider>
  );
}
