// The list of files and folders: a row each, with a box to choose it, its name (opening it), who is
// in it, when it changed and how big it is, and one menu of everything that can be done with it.
// Rows are dragged to move or copy them, and folders take what is dropped on them.

import { ArrowDown, ArrowUp, Star } from "lucide-react";
import { type DragEvent, Fragment, useEffect, useRef } from "react";
import { Link } from "react-router";
import { formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Badge } from "@ferrum/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, buttonVariants } from "@ferrum/kit/primitives";
import { CARRIES, carry } from "./drag";
import { useDropTarget } from "./dropping";
import { EditorLink } from "./editors";
import { FileGlyph } from "./FileGlyph";
import { type BrowserEditor, type Item, allows, defaultEditor, editorsFor, shared, shownName, sizeLabel } from "./files";
import type { RowActions } from "./ItemMenu";
import { ItemMenuLater as ItemMenu } from "./ItemMenuLater";
import { RenameField } from "./Rename";
import { type Order, type SortKey, type View, whereLine } from "./listing";
import { joinable, presenceLabel, type Present } from "./presence";

export interface Editors {
  online: boolean;
  browser: BrowserEditor[];
  docs: boolean;
}

export type { RowActions };

/** Marks the words a search found, which the server puts between « and ». */
function Marked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) => (part.startsWith("«") ? <mark key={i}>{isolate(part.slice(1, -1))}</mark> : <Fragment key={i}>{isolate(part)}</Fragment>))}
    </>
  );
}

/** A row or card is picked up: the items it carries go with the drag; several are shown as a count, not as one row. */
export function beginDrag(e: DragEvent, it: Item, actions: RowActions) {
  const carrying = actions.dragStart(it);
  e.dataTransfer.setData(CARRIES, carry(carrying));
  e.dataTransfer.setData("text/plain", carrying.map((c) => c.name).join("\n"));
  e.dataTransfer.effectAllowed = "copyMove";
  if (carrying.length > 1) {
    const ghost = document.createElement("div");
    ghost.className = "drive-ghost";
    ghost.textContent = tr("{length} items", { length: carrying.length });
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  }
}

/** Whether a click landed on something with a use of its own (a link, a button, a box). */
export const interactive = (t: EventTarget) => !!(t as Element).closest?.("a, button, input, [role='menuitem']");

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
  renaming,
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
  renaming: boolean;
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
  const when = trash && it.trashed_at ? tr("Deleted {value}", { value: formatDateTime(it.trashed_at) }) : formatDateTime(it.modified_at);

  return (
    <TableRow
      className="drive-row"
      data-row={it.id}
      data-state={shown ? "selected" : undefined}
      data-chosen={chosen || undefined}
      data-over={drop.over || undefined}
      tabIndex={-1}
      draggable={draggable}
      onDragStart={draggable ? (e) => beginDrag(e, it, actions) : undefined}
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
          {renaming ? (
            <span className="drive-name">
              {glyph}
              <RenameField initial={name} folder={it.kind === "folder"} onDone={(next) => actions.renameTo(it, next)} onCancel={actions.stopRenaming} />
            </span>
          ) : it.kind === "folder" && !trash ? (
            <Link to={`/drive/${it.id}`} className="drive-name" draggable={false}>
              {glyph}
              <span className="truncate" title={name}>{isolate(name)}</span>
            </Link>
          ) : !trash ? (
            <Link to={actions.previewTo(it)} className="drive-name" draggable={false}>
              {glyph}
              <span className="truncate" title={name}>{isolate(name)}</span>
            </Link>
          ) : (
            <span className="drive-name">
              {glyph}
              <span className="truncate" title={name}>{isolate(name)}</span>
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
          <div className="drive-line drive-line-clamp" title={line.replace(/[«»]/g, "")}>
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
        <ItemMenu it={it} trash={trash} open={open} others={others} here={here} templates={templates} actions={actions} />
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
  renaming,
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
  /** The item being renamed in place. */
  renaming: string | null;
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
            renaming={renaming === it.id}
            actions={actions}
          />
        ))}
      </TableBody>
    </Table>
  );
}
