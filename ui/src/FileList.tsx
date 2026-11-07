// The list of files and folders: a row each, with a box to choose it, its name (opening it), who is
// in it, when it changed and how big it is, and one menu of everything that can be done with it.
// Rows are dragged to move or copy them, and folders take what is dropped on them.

import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  Info,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Share2,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { type DragEvent, Fragment, useEffect, useRef } from "react";
import { Link } from "react-router";
import { formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Badge, toast } from "@ferrum/kit";
import {
  Button as UiButton,
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
  buttonVariants,
} from "@ferrum/kit/primitives";
import { type Carried, CARRIES, carry } from "./drag";
import { useDropTarget } from "./dropping";
import { EditorLink, openChoice } from "./editors";
import { FileGlyph } from "./FileGlyph";
import { type BrowserEditor, type Item, allows, defaultEditor, editorsFor, shared, shownName, sizeLabel } from "./files";
import { type Order, type SortKey, type View, whereLine } from "./listing";
import { joinable, presenceLabel, type Present } from "./presence";
import { templatable } from "./templateList";

export interface Editors {
  online: boolean;
  browser: BrowserEditor[];
  docs: boolean;
}

/** What a row can ask the page to do. They are the same functions for every row. */
export interface RowActions {
  open: (it: Item) => void;
  details: (it: Item) => void;
  share: (it: Item) => void;
  star: (it: Item) => void;
  rename: (it: Item) => void;
  move: (it: Item, copy: boolean) => void;
  download: (it: Item) => void;
  trash: (it: Item) => void;
  restore: (it: Item) => void;
  destroy: (it: Item) => void;
  saveTemplate: (it: Item) => void;
  navigate: (to: string) => void;
  /** Chooses or unchooses a row (with Shift: the stretch from the last chosen). */
  choose: (id: string, shift: boolean) => void;
  chooseAll: (on: boolean) => void;
  /** A row is picked up: the items the drag carries. */
  dragStart: (row: Item) => Carried[];
  dragEnd: () => void;
}

/** Marks the words a search found, which the server puts between « and ». */
function Marked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) => (part.startsWith("«") ? <mark key={i}>{isolate(part.slice(1, -1))}</mark> : <Fragment key={i}>{isolate(part)}</Fragment>))}
    </>
  );
}

/** Whether a click landed on something with a use of its own (a link, a button, a box). */
const interactive = (t: EventTarget) => !!(t as Element).closest?.("a, button, input, [role='menuitem']");

function Row({
  it,
  view,
  inFolder,
  chosen,
  shown,
  here,
  editors,
  narrow,
  templates,
  actions,
}: {
  it: Item;
  view: View;
  inFolder: boolean;
  chosen: boolean;
  shown: boolean;
  here: Present[];
  editors: Editors;
  narrow: boolean;
  templates: boolean;
  actions: RowActions;
}) {
  const trash = view === "trash";
  const choices = it.kind === "file" && !trash ? editorsFor(it, editors) : [];
  const open = defaultEditor(choices, narrow);
  const others = choices.filter((c) => c !== open);
  // Others editing where people edit together: join them there.
  const editing = here.filter((p) => p.mode === "edit");
  const joins = !!open && shared(open.key) && joinable(here);
  const name = shownName(it.name);
  const glyph = <FileGlyph kind={it.kind} name={it.name} />;
  const drop = useDropTarget(it.kind === "folder" && !trash ? { id: it.id, name, permission: it.permission } : null);
  const draggable = !trash && allows(it.permission, "Edit");
  const line = whereLine(it, view, inFolder);
  const when = trash && it.trashed_at ? `Deleted ${formatDateTime(it.trashed_at)}` : formatDateTime(it.modified_at);

  const dragStart = (e: DragEvent) => {
    const carrying = actions.dragStart(it);
    e.dataTransfer.setData(CARRIES, carry(carrying));
    e.dataTransfer.setData("text/plain", carrying.map((c) => c.name).join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
    // Several items are dragged as a count, not as one row.
    if (carrying.length > 1) {
      const ghost = document.createElement("div");
      ghost.className = "drive-ghost";
      ghost.textContent = `${carrying.length} items`;
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  };

  return (
    <TableRow
      className="drive-row"
      data-row={it.id}
      data-state={shown ? "selected" : undefined}
      data-chosen={chosen || undefined}
      data-over={drop.over || undefined}
      tabIndex={-1}
      draggable={draggable}
      onDragStart={draggable ? dragStart : undefined}
      onDragEnd={draggable ? actions.dragEnd : undefined}
      // Shift-clicking a row's empty space chooses a stretch; it should not also select its text.
      onMouseDown={(e) => e.shiftKey && !interactive(e.target) && e.preventDefault()}
      onClick={(e) => {
        // Command or Ctrl on a row's empty space chooses it, as on a computer's files.
        if ((e.metaKey || e.ctrlKey || e.shiftKey) && !interactive(e.target)) actions.choose(it.id, e.shiftKey);
      }}
      onDoubleClick={(e) => !interactive(e.target) && !trash && actions.open(it)}
      {...drop.props}
    >
      <TableCell className="w-10 py-2 pe-0 ps-3">
        <input
          type="checkbox"
          className="drive-check"
          checked={chosen}
          aria-label={tr("Choose {name}", { name })}
          onChange={() => undefined}
          onClick={(e) => actions.choose(it.id, e.shiftKey)}
        />
      </TableCell>
      <TableCell className="w-full max-w-0 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {it.kind === "folder" && !trash ? (
            <Link to={`/drive/${it.id}`} className="drive-name" draggable={false}>
              {glyph}
              <span className="truncate">{isolate(name)}</span>
            </Link>
          ) : open ? (
            <EditorLink choice={open} className="drive-name">
              {glyph}
              <span className="truncate">{isolate(name)}</span>
            </EditorLink>
          ) : (
            <span className="drive-name">
              {glyph}
              <span className="truncate">{isolate(name)}</span>
            </span>
          )}
          {it.starred && <Star aria-label={tr("Starred")} size={14} className="drive-starred" />}
          {it.locked_by && <Badge tone="amber">{tr("Checked out")}</Badge>}
          {here.length > 0 && (
            <Badge tone="green" title={presenceLabel(here)}>
              {isolate(presenceLabel(here))}
            </Badge>
          )}
        </div>
        {line && (
          <div className="drive-line">
            <Marked text={line} />
          </div>
        )}
        <div className="drive-line sm:hidden">
          {isolate([sizeLabel(it.size), when].filter(Boolean).join(" · "))}
        </div>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
        {isolate(when)}
        {!trash && it.modified_by && <span className="hidden lg:inline"> · {isolate(it.modified_by)}</span>}
      </TableCell>
      <TableCell className="hidden text-end whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">{isolate(sizeLabel(it.size))}</TableCell>
      <TableCell className="py-1 text-end whitespace-nowrap">
        {joins && open && (
          <EditorLink className={`${buttonVariants({ size: "xs" })} me-1`} choice={open} aria-label={tr("Join {value} in {name}", { value: presenceLabel(editing).replace(/ (is|are) editing$/, ""), name })}>
            {tr("Join")}
          </EditorLink>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <UiButton variant="ghost" size="icon-sm" aria-label={tr("More for {name}", { name })} className="text-muted-foreground">
              <MoreHorizontal />
            </UiButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {trash ? (
              <>
                <DropdownMenuItem onSelect={() => actions.restore(it)}>
                  <ArchiveRestore /> {tr("Restore")}
                </DropdownMenuItem>
                {allows(it.permission, "Manage") && (
                  <DropdownMenuItem variant="destructive" onSelect={() => actions.destroy(it)}>
                    <Trash2 /> {tr("Delete forever")}
                  </DropdownMenuItem>
                )}
              </>
            ) : (
              <>
                {open && (
                  <DropdownMenuItem onSelect={() => openChoice(open, actions.navigate)}>
                    <ExternalLink /> {open.key === "live" || open.key === "view" || !allows(it.permission, "Edit") || editing.length > 0 ? tr("Open") : tr("Edit online")}
                  </DropdownMenuItem>
                )}
                {others.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <ExternalLink /> {tr("Open with")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-52">
                      {others.map((c) => (
                        <DropdownMenuItem key={c.key} onSelect={() => (c.unavailable ? toast(tr("{label} cannot open {name}: {unavailable}", { label: c.label, name, unavailable: c.unavailable }), "error") : openChoice(c, actions.navigate))}>
                          <span className="grid">
                            {isolate(c.label)}
                            {c.unavailable && <span className="text-xs text-muted-foreground">{isolate(c.unavailable)}</span>}
                            {!c.unavailable && editing.length > 0 && (
                              <span className="text-xs text-muted-foreground">{shared(c.key) && joinable(here) ? tr("Join {value}", { value: editing.map((p) => p.name).join(", ") }) : tr("Read only while others edit")}</span>
                            )}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {(open || others.length > 0) && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => actions.details(it)}>
                  <Info /> {tr("Details")}
                </DropdownMenuItem>
                {allows(it.permission, "Manage") && (
                  <DropdownMenuItem onSelect={() => actions.share(it)}>
                    <Share2 /> {tr("Share")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => actions.star(it)}>
                  {it.starred ? <StarOff /> : <Star />} {it.starred ? tr("Remove star") : tr("Star")}
                </DropdownMenuItem>
                {allows(it.permission, "Edit") && (
                  <DropdownMenuItem onSelect={() => actions.rename(it)}>
                    <Pencil /> {tr("Rename")}
                  </DropdownMenuItem>
                )}
                {allows(it.permission, "Edit") && (
                  <DropdownMenuItem onSelect={() => actions.move(it, false)}>
                    <FolderInput /> {tr("Move to…")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => actions.move(it, true)}>
                  <Copy /> {tr("Copy to…")}
                </DropdownMenuItem>
                {it.kind === "file" && (
                  <DropdownMenuItem onSelect={() => actions.download(it)}>
                    <Download /> {tr("Download")}
                  </DropdownMenuItem>
                )}
                {it.kind === "file" && templates && templatable(it.name) && (
                  <DropdownMenuItem onSelect={() => actions.saveTemplate(it)}>
                    <LayoutTemplate /> {tr("Save as a template")}
                  </DropdownMenuItem>
                )}
                {allows(it.permission, "Edit") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => actions.trash(it)}>
                      <Trash2 /> {tr("Move to trash")}
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
}

/** A heading that sorts by its column when pressed. */
function SortHead({ id, label, sort, order, onSort, className }: { id: SortKey; label: string; sort: SortKey | null; order: Order; onSort: (id: SortKey) => void; className?: string }) {
  const on = sort === id;
  return (
    <TableHead className={className} aria-sort={on ? (order === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="drive-sort" onClick={() => onSort(id)}>
        {isolate(label)}
        {on && (order === "asc" ? <ArrowUp aria-hidden size={13} /> : <ArrowDown aria-hidden size={13} />)}
      </button>
    </TableHead>
  );
}

export function FileList({
  items,
  view,
  inFolder,
  chosen,
  shown,
  present,
  editors,
  narrow,
  templates,
  sort,
  order,
  sortable,
  onSort,
  actions,
}: {
  items: Item[];
  view: View;
  inFolder: boolean;
  chosen: ReadonlySet<string>;
  /** The item whose details are open. */
  shown: string | null;
  present: Record<string, Present[]>;
  editors: Editors;
  narrow: boolean;
  templates: boolean;
  sort: SortKey | null;
  order: Order;
  /** Columns sort only where the server or the page can. */
  sortable: SortKey[];
  onSort: (id: SortKey) => void;
  actions: RowActions;
}) {
  const all = useRef<HTMLInputElement>(null);
  const some = items.some((i) => chosen.has(i.id));
  const every = items.length > 0 && items.every((i) => chosen.has(i.id));
  useEffect(() => {
    if (all.current) all.current.indeterminate = some && !every;
  }, [some, every]);
  const head = (id: SortKey, label: string, className?: string) =>
    sortable.includes(id) ? (
      <SortHead id={id} label={label} sort={sort} order={order} onSort={onSort} className={className} />
    ) : (
      <TableHead className={className}>{isolate(label)}</TableHead>
    );
  return (
    <Table className="drive-list">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10 pe-0 ps-3">
            <input ref={all} type="checkbox" className="drive-check" checked={every} aria-label={tr("Choose every item shown")} onChange={(e) => actions.chooseAll(e.target.checked)} />
          </TableHead>
          {head("name", tr("Name"))}
          {head("modified", view === "trash" ? tr("Deleted") : tr("Modified"), "hidden md:table-cell")}
          {head("size", tr("Size"), "hidden text-right sm:table-cell")}
          <TableHead className="w-12">
            <span className="sr-only">{tr("Actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) => (
          <Row
            key={it.id}
            it={it}
            view={view}
            inFolder={inFolder}
            chosen={chosen.has(it.id)}
            shown={it.id === shown}
            here={present[it.id] ?? []}
            editors={editors}
            narrow={narrow}
            templates={templates}
            actions={actions}
          />
        ))}
      </TableBody>
    </Table>
  );
}
