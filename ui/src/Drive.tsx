// Drive (the drive app's /api/app/drive endpoints): the person's files in a folder, with the places
// they come from beside it (My files, what is shared with them, recent, starred, the trash and the
// team folders they belong to), and search; Sheets, Slides and PDF (Drive's files of one kind).
// Long folders load as the person scrolls. Several items are chosen to act on all of them; items
// move by dragging onto a folder (or from a menu and a destination picker); files and folders are
// uploaded by dropping them on the page (handed to the shell, so it goes on in other apps' pages).
// New folders and files, or ones from a template; sharing, comments, versions and activity in a
// panel beside the list; who has a file open now (presence.ts). Files open in the editor server the
// operator runs (Collabora Online or ONLYOFFICE, over WOPI), in a browser editor an add-on offers
// (BrowserEdit.tsx), or, for documents edited live, in Docs' editor (another app's page).

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, FileUp, FolderPlus, FolderUp, HardDrive, LayoutTemplate, Plus, Trash2, Upload } from "lucide-react";
import { type DragEvent, type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, errorMessage, shell } from "@ferrum/client";
import { Button, Dialog, EmptyState, ErrorState, FamilyNav, Field, Spinner, toast, useShellTitle } from "@ferrum/kit";
import {
  Button as UiButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from "@ferrum/kit/primitives";
import { BulkBar } from "./BulkBar";
import { Chips, type SetQuery } from "./Chips";
import { type Carried, bringsFiles, dragged } from "./drag";
import { type DropApi, DropContext, type DropTarget, useDropTarget } from "./dropping";
import { type Entry, type Tree, entriesOf, fromPicker, walk } from "./dropped";
import { openChoice, useDocs, useEditors } from "./editors";
import { FileGlyph } from "./FileGlyph";
import { FileList, type RowActions } from "./FileList";
import { type Item, type Shareable, allows, defaultEditor, editorsFor, isLiveDoc, shownName } from "./files";
import { DetailsPanel, BulkShareDialog, Later, LaterPanel, MoveDialog, NewTeamDialog, SaveTemplateDialog, ShareDialog, ShortcutsDialog, TeamDialog, TemplateDialog } from "./later";
import { VIEWS, abilities, defaultSort, emptyText, filtersOn, naturalOrder, readQuery, shownOf, sourceOf, viewOf } from "./listing";
import { useFilesPresence } from "./presence";
import { Rail, type Place } from "./Rail";
import { NOTHING, type Chosen, all as chooseEvery, click, keep, targets } from "./selection";
import { commandFor, typing } from "./shortcuts";
import { useTemplates } from "./templateList";
import { useActions } from "./useActions";
import { useFolder, useFresh, useListing, useSpace, useUsage } from "./useDrive";

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
  Spreadsheet: { title: "Sheets", noun: "spreadsheets", fresh: { kind: "xlsx", label: "New spreadsheet" } },
  Presentation: { title: "Slides", noun: "presentations", fresh: { kind: "pptx", label: "New presentation" } },
  PDF: { title: "PDF", noun: "PDFs", fresh: null },
} as const;
export type FileKind = keyof typeof KINDS;

/** One step of the folder path above the list; a folder in it takes drops. */
function Crumb({ id, name, last }: { id: string; name: string; last: boolean }) {
  const drop = useDropTarget(last ? null : { id, name });
  return last ? (
    <span aria-current="location">{name}</span>
  ) : (
    <Link to={`/drive/${id}`} className="drive-crumb" data-over={drop.over || undefined} {...drop.props}>
      {name}
    </Link>
  );
}

/** Placeholders for a list on its way. */
function ListSkeleton() {
  return (
    <div className="drive-skeleton" role="status" aria-label="Loading files">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="drive-skeleton-row">
          <Skeleton className="size-5 rounded motion-reduce:animate-none" />
          <Skeleton className="h-4 flex-1 motion-reduce:animate-none" style={{ maxWidth: `${55 - i * 4}%` }} />
        </div>
      ))}
    </div>
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
        {hasMore ? `Showing ${shownOf(shown, total)}` : shown === 1 ? "1 item" : `${shown.toLocaleString()} items`}
      </span>
      {hasMore && (
        <UiButton size="sm" variant="outline" disabled={loading} onClick={load}>
          {loading ? "Loading…" : "Show more"}
        </UiButton>
      )}
    </div>
  );
}

/** The row to move the focus to, in the order of the list. */
const rowOf = (el: Element | null) => el?.closest<HTMLElement>("[data-row]")?.dataset.row ?? null;

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
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const present = useFilesPresence(items.filter((i) => i.kind === "file").map((i) => i.id)).data ?? {};
  const chosenItems = useMemo(() => items.filter((i) => chosen.selected.has(i.id)), [items, chosen]);
  const current = head.data;
  const listKey = JSON.stringify([src, kind]);
  useEffect(() => setChosen(NOTHING), [listKey]);
  useEffect(() => setChosen((c) => keep(c, ids)), [ids]);
  useEffect(() => setPlaces(false), [folder, view, query, kind]);

  // An item opened from a link or the bell: shown in its own folder.
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
  const actions = useActions({ space: space.data?.id, hide, show, after: refresh, most: usage.data?.limits.max_upload_bytes ?? null });

  // Finished anywhere (this page, another tab, an earlier page): the lists show it.
  useEffect(() => shell().uploads.on("done", (u) => void (u.app === "drive" && qc.invalidateQueries({ queryKey: ["drive"] }))), [qc]);

  const title = query ? `Search: ${query}` : kind ? KINDS[kind].title : inFolder ? (id === root ? "My files" : (current?.name ?? "Drive")) : VIEWS.find((v) => v.id === view)!.label;
  useShellTitle(title);
  const canAdd = (inFolder && !!current && allows(current.permission, "Edit")) || (!!kind && !query && !!space.data);
  const targetName = !target || target === root ? "My files" : (current?.name ?? "this folder");
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
    toast(`Made “${made.name}”`);
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
    setNaming({ title: "New folder", label: "Name", initial: "", done: (name) => attempt(() => actions.act("create_folder", { parent: id, name }), `Folder “${name}” made`) });
  const rename = (it: Item) =>
    setNaming({
      title: `Rename “${shownName(it.name)}”`,
      label: "New name",
      initial: shownName(it.name),
      // A live document stays one: its name keeps `.fdoc`, which people never see.
      done: (name) => attempt(() => actions.act("rename", { item: it.id, name: isLiveDoc(it.name) ? `${shownName(name)}.fdoc` : name }), "Renamed"),
    });
  const openItem = (it: Item) => {
    if (it.kind === "folder") return navigate(`/drive/${it.id}`);
    const open = defaultEditor(editorsFor(it, editors), narrow);
    if (open) openChoice(open, navigate);
    else pick({ item: it.id });
  };

  /** Uploads what was dropped or chosen into a folder; `read` finds the files and folders. */
  const uploadTo = async (read: () => Promise<Tree> | Tree, to: DropTarget) => {
    setBusy(true);
    try {
      await actions.upload(await read(), to);
    } catch (e) {
      toast(errorMessage(e), "error");
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
    details: (it) => pick({ item: it.id }),
    share: setSharing,
    star: (it) => void actions.star([it]),
    rename,
    move: (it, copy) => setMoving({ items: [it], copy }),
    download: (it) => void actions.download([it]),
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

  // Keys. The handler is the latest render's; the listener is put up once.
  const keys = useRef<(e: KeyboardEvent) => void>(undefined);
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // Fields, menus and dialogs keep their keys; so does the bar (its own tree) and anything outside the page.
    if (typing(e.composedPath()[0] ?? e.target)) return;
    const at = e.target as Element;
    if (at !== document.body && !at.closest?.("#main")) return;
    const command = commandFor(e);
    if (!command) return;
    const focus = rowOf(document.activeElement);
    const byId = new Map(items.map((i) => [i.id, i]));
    const acting = () => targets(chosen.selected, focus, ids).flatMap((i) => byId.get(i) ?? []);
    const bin = view === "trash";
    const stop = () => e.preventDefault();
    switch (command) {
      case "help":
        stop();
        return setHelping(true);
      case "search":
        stop();
        return searchBox.current?.focus();
      case "next":
      case "previous":
      case "first":
      case "last": {
        if (!ids.length) return;
        stop();
        const now = focus ? ids.indexOf(focus) : -1;
        const to = command === "first" ? 0 : command === "last" ? ids.length - 1 : command === "next" ? Math.min(now + 1, ids.length - 1) : Math.max(now - 1, 0);
        const row = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(ids[to])}"]`);
        row?.focus();
        return row?.scrollIntoView({ block: "nearest" });
      }
      case "open": {
        // Enter on a link or button does its own thing; on the row itself it opens the item.
        const it = focus && (at as HTMLElement).dataset?.row ? byId.get(focus) : undefined;
        if (!it || bin) return;
        stop();
        return openItem(it);
      }
      case "choose":
        if (!focus || at.closest("input, button")) return;
        stop();
        return setChosen((c) => click(c, ids, focus, false));
      case "all":
        stop();
        return setChosen(chooseEvery(ids));
      case "clear":
        if (places) return setPlaces(false);
        if (chosen.selected.size) return setChosen(NOTHING);
        return selected ? pick({ item: null }) : undefined;
      case "details": {
        const [it] = acting();
        if (!it) return;
        stop();
        return pick({ item: it.id });
      }
      case "folder":
        if (!canAdd) return;
        stop();
        return newFolder();
      case "upload":
        if (!canAdd) return;
        stop();
        return picker.current?.click();
      default:
        break;
    }
    // The rest changes things: not in the trash, and only what the person may change.
    if (bin) return;
    const list = acting();
    if (!list.length) return;
    const edit = list.every((i) => allows(i.permission, "Edit"));
    const manage = list.every((i) => allows(i.permission, "Manage"));
    switch (command) {
      case "rename":
        if (list.length === 1 && edit) {
          stop();
          rename(list[0]);
        }
        break;
      case "trash":
        if (edit) {
          stop();
          void actions.trash(list);
        }
        break;
      case "star":
        stop();
        void actions.star(list);
        break;
      case "move":
      case "copy":
        if (command === "copy" || edit) {
          stop();
          setMoving({ items: list, copy: command === "copy" });
        }
        break;
      case "share":
        if (manage) {
          stop();
          if (list.length === 1) setSharing(list[0]);
          else setSharingMany(list);
        }
        break;
    }
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
        return toast("You cannot add files here", "error");
      }
      dropFiles(entriesOf(e.dataTransfer), { id: target, name: targetName });
    },
  };

  const empty = emptyText({ view, query, filtered, canAdd, kind: kind ? KINDS[kind].noun : undefined, trashDays: usage.data?.limits.trash_days });
  const fresh = kind ? (KINDS[kind].fresh ? [KINDS[kind].fresh] : []) : NEW.filter((n) => n.kind !== "fdoc" || docs);
  const problem = space.error ?? head.error ?? list.error;
  const waiting = list.loading || (space.isPending && !src);

  const body = problem ? (
    <ErrorState error={problem} title="Drive could not show this" onRetry={() => void qc.invalidateQueries({ queryKey: ["drive"] })} />
  ) : waiting ? (
    <ListSkeleton />
  ) : !items.length ? (
    <EmptyState title={empty.title} icon={view === "trash" && !query ? "trash" : "file"}>
      <p className="muted">{empty.hint}</p>
      {query && (
        <Button onClick={() => navigate(kind ? location.pathname : "/drive")}>Clear the search</Button>
      )}
      {!query && filtered && <Button onClick={() => setQuery({ type: null, since: null, owner: null })}>Clear filters</Button>}
    </EmptyState>
  ) : (
    <>
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
        sort={sort}
        order={order}
        sortable={can.sorts}
        onSort={(key) => setQuery({ sort: key, order: key === sort ? (order === "asc" ? "desc" : "asc") : null })}
        actions={rows}
      />
      <More shown={items.length} total={list.total} hasMore={list.hasMore} loading={list.loadingMore} load={list.loadMore} />
    </>
  );

  return (
    <DropContext.Provider value={dropApi}>
      <div ref={shellBox} className="drive-shell" data-details={selected ? "" : undefined} {...overPage}>
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
              <h1 className="page-title">{title}</h1>
              {crumbs.length > 0 && (
                <nav className="page-sub drive-crumbs" aria-label="Folder path">
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
                <HardDrive aria-hidden size={14} /> Places
              </button>
              {canAdd && (
                <>
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
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiButton size="sm" disabled={busy}>
                        {busy ? <Spinner small /> : <Upload />} Upload <ChevronDown />
                      </UiButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-44">
                      <DropdownMenuItem onSelect={() => picker.current?.click()}>
                        <FileUp /> Files…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => folderPicker.current?.click()}>
                        <FolderUp /> Folder…
                      </DropdownMenuItem>
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
                <UiButton size="sm" variant="outline" onClick={() => void actions.emptyTrash()}>
                  <Trash2 /> Empty the trash
                </UiButton>
              )}
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
                Search Drive
              </label>
              <input ref={searchBox} id={`${railId}-q`} className="input" type="search" placeholder="Search Drive" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </form>
            <Chips src={src} fileType={kind} q={q} set={setQuery} />
          </div>
          {src?.kind === "search" && src.folder && !query && (
            <p className="faint drive-note" role="status">
              Looking in “{targetName}” and the folders inside it.
            </p>
          )}
          {chosenItems.length > 0 && (
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
            <div>{canAdd ? `Drop files or folders to upload them to “${targetName}”` : "You cannot add files here"}</div>
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
      {naming && <NameDialog {...naming} onClose={() => setNaming(null)} />}
    </DropContext.Provider>
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
