// The files and folders as cards: a picture for an image (a small one; larger pictures and every other
// kind of file show their kind's icon, since the server makes no thumbnails and a grid of two hundred
// full-size originals is not a thing to download), the name, and the same menu as a row. Cards are
// chosen, dragged, dropped on and opened as rows are.

import { Star } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Badge } from "@ferrum/kit";
import { useDropTarget } from "./dropping";
import { type Editors, beginDrag, interactive } from "./FileList";
import { FileGlyph } from "./FileGlyph";
import { type Item, allows, contentUrl, defaultEditor, editorsFor, lookOf, shownName, sizeLabel } from "./files";
import { ItemMenu, type RowActions } from "./ItemMenu";
import { thumbnailable } from "./kinds";
import { presenceLabel, type Present } from "./presence";
import { RenameField } from "./Rename";
import type { View } from "./listing";

/** A card's picture: the image itself when it is small enough to be worth fetching, else its kind's icon. */
function Picture({ it }: { it: Item }) {
  const [failed, setFailed] = useState(false);
  const look = lookOf(it.kind, it.name);
  if (it.kind === "file" && thumbnailable(it.name, it.size) && !failed)
    return <img className="drive-thumb" src={`${contentUrl(it.id)}?inline=1&thumb=1`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  return (
    <span className="drive-thumb-icon" data-look={look}>
      <FileGlyph kind={it.kind} name={it.name} size={44} />
    </span>
  );
}

function Card({
  it,
  view,
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
  const name = shownName(it.name);
  const drop = useDropTarget(it.kind === "folder" && !trash ? { id: it.id, name, permission: it.permission } : null);
  const draggable = !trash && allows(it.permission, "Edit");
  const to = it.kind === "folder" ? { pathname: `/drive/${it.id}` } : trash ? null : actions.previewTo(it);
  const when = trash && it.trashed_at ? tr("Deleted {value}", { value: formatDateTime(it.trashed_at) }) : formatDateTime(it.modified_at);
  return (
    <li
      className="drive-card"
      data-row={it.id}
      data-state={shown ? "selected" : undefined}
      data-chosen={chosen || undefined}
      data-over={drop.over || undefined}
      tabIndex={-1}
      draggable={draggable}
      onDragStart={draggable ? (e) => beginDrag(e, it, actions) : undefined}
      onDragEnd={draggable ? actions.dragEnd : undefined}
      onMouseDown={(e) => e.shiftKey && !interactive(e.target) && e.preventDefault()}
      onClick={(e) => {
        if ((e.metaKey || e.ctrlKey || e.shiftKey) && !interactive(e.target)) actions.choose(it.id, e.shiftKey);
      }}
      onDoubleClick={(e) => !interactive(e.target) && !trash && actions.open(it)}
      {...drop.props}
    >
      <div className="drive-card-tools">
        <input type="checkbox" className="drive-check" checked={chosen} aria-label={tr("Choose {name}", { name })} onChange={() => undefined} onClick={(e) => actions.choose(it.id, e.shiftKey)} />
        {it.starred && <Star aria-label={tr("Starred")} size={14} className="drive-starred" />}
        <span className="spacer" />
        <ItemMenu it={it} trash={trash} open={open} others={others} here={here} templates={templates} actions={actions} />
      </div>
      {to ? (
        <Link to={to} className="drive-card-pic" draggable={false} tabIndex={-1} aria-hidden="true">
          <Picture it={it} />
        </Link>
      ) : (
        <div className="drive-card-pic">
          <Picture it={it} />
        </div>
      )}
      <div className="drive-card-name">
        {renaming ? (
          <RenameField initial={name} folder={it.kind === "folder"} onDone={(next) => actions.renameTo(it, next)} onCancel={actions.stopRenaming} />
        ) : to ? (
          <Link to={to} className="drive-name" draggable={false}>
            <FileGlyph kind={it.kind} name={it.name} size={16} />
            <span className="truncate" dir="auto" title={name}>{isolate(name)}</span>
          </Link>
        ) : (
          <span className="drive-name">
            <FileGlyph kind={it.kind} name={it.name} size={16} />
            <span className="truncate" dir="auto" title={name}>{isolate(name)}</span>
          </span>
        )}
      </div>
      <div className="drive-line truncate">{isolate([it.kind === "file" ? sizeLabel(it.size) : "", when].filter(Boolean).join(" · "))}</div>
      {(it.locked_by || here.length > 0) && (
        <div className="drive-card-badges">
          {it.locked_by && <Badge tone="amber">{tr("Checked out")}</Badge>}
          {here.length > 0 && (
            <Badge tone="green" title={presenceLabel(here)}>
              {isolate(presenceLabel(here))}
            </Badge>
          )}
        </div>
      )}
    </li>
  );
}

export function FileGrid({
  items,
  view,
  chosen,
  shown,
  present,
  editors,
  narrow,
  templates,
  renaming,
  actions,
}: {
  items: Item[];
  view: View;
  chosen: ReadonlySet<string>;
  shown: string | null;
  present: Record<string, Present[]>;
  editors: Editors;
  narrow: boolean;
  templates: boolean;
  renaming: string | null;
  actions: RowActions;
}) {
  const folders = items.filter((i) => i.kind === "folder");
  const files = items.filter((i) => i.kind === "file");
  const both = folders.length > 0 && files.length > 0;
  const group = (list: Item[], label: string) =>
    list.length > 0 && (
      <section aria-label={label}>
        {both && <h2 className="drive-grid-head">{label}</h2>}
        <ul className="drive-grid">
          {list.map((it) => (
            <Card key={it.id} it={it} view={view} chosen={chosen.has(it.id)} shown={it.id === shown} here={present[it.id] ?? []} editors={editors} narrow={narrow} templates={templates} renaming={renaming === it.id} actions={actions} />
          ))}
        </ul>
      </section>
    );
  return (
    <div className="drive-grid-wrap">
      {group(folders, tr("Folders"))}
      {group(files, tr("Files"))}
    </div>
  );
}
