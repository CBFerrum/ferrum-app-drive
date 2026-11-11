// Choosing where items go: a way to move or copy that needs no dragging. It opens in the folder the
// person is in (or at their places) and goes down folder by folder, as far as they like; the folder
// they are in when they press the button is where the items go.

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { useState } from "react";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Button, Dialog, Spinner } from "@ferrum/kit";
import { items as count } from "./bulk";
import { type Crumb, type Item, allows, shownName } from "./files";
import { nextOffset } from "./listing";
import type { Usage } from "./usage";

interface Opened {
  folder: Item;
  breadcrumbs: Crumb[];
  items: Item[];
  folders: number;
  offset: number;
}

export interface Destination {
  id: string;
  name: string;
}

export function MoveDialog({
  items,
  copy,
  start,
  root,
  usage,
  pick,
  onChoose,
  onClose,
}: {
  items: Item[];
  copy: boolean;
  /** The folder to open first; none opens the person's places. */
  start: string | null;
  /** The person's top folder. */
  root: string;
  usage: Usage | undefined;
  /** Choosing a folder for something other than moving items (a search's place): its title and its button. */
  pick?: { title: string; button: string };
  onChoose: (to: Destination) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState<string | null>(start);
  const moving = new Set(items.map((i) => i.id));
  const list = useInfiniteQuery({
    queryKey: ["drive", "picker", at],
    enabled: !!at,
    staleTime: 0,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.get<Omit<Opened, "offset">>("/api/app/drive/list_folder", { folder: at!, limit: 200, offset: pageParam || undefined }, signal).then((r) => ({ ...r, offset: pageParam })),
    // Folders come before files: nothing past the last folder is of use here.
    getNextPageParam: (last) => nextOffset(last.offset, last.items.length, { total: last.folders }),
  });
  const first = list.data?.pages[0];
  const folders = (list.data?.pages ?? []).flatMap((p) => p.items).filter((i) => i.kind === "folder" && !moving.has(i.id));
  const here = first?.folder;
  const name = (c: Crumb) => (c.id === root ? tr("My files") : c.name);
  const verb = copy ? tr("Copy") : tr("Move");
  const title = pick ? pick.title : items.length === 1 ? tr("{verb} “{value}” to…", { verb, value: shownName(items[0].name) }) : tr("{verb} {value} to…", { verb, value: count(items.length) });
  // The reasons the button waits, in words.
  const why = !at
    ? tr("Open a folder to choose it.")
    : !here
      ? null
      : pick
        ? null
        : !allows(here.permission, "Edit")
        ? tr("You cannot add to this folder. Choose another.")
        : !copy && items.every((i) => (i.parent ?? null) === here.id)
          ? tr("They are in this folder already.")
          : null;
  const place = (id: string, label: string, icon: "drive" | "folder") => (
    <li key={id}>
      <button type="button" className="drive-pick-item drive-dest" onClick={() => setAt(id)}>
        {icon === "drive" ? <HardDrive aria-hidden size={18} className="drive-glyph" /> : <Folder aria-hidden size={18} className="drive-glyph drive-glyph-folder" />}
        <span className="drive-pick-name">{isolate(label)}</span>
        <ChevronRight aria-hidden size={16} className="faint" />
      </button>
    </li>
  );

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          {why && <span className="faint drive-dest-why">{isolate(why)}</span>}
          <span className="spacer" />
          <Button onClick={onClose}>{tr("Cancel")}</Button>
          <Button variant="primary" disabled={!at || !here || !!why} onClick={() => here && onChoose({ id: here.id, name: here.id === root ? tr("My files") : here.name })}>
            {pick ? pick.button : tr("{verb} here", { verb })}
          </Button>
        </>
      }
    >
      <nav className="drive-dest-path" aria-label={tr("Where you are")}>
        <button type="button" onClick={() => setAt(null)} aria-current={!at ? "location" : undefined}>
          {tr("Places")}
        </button>
        {first?.breadcrumbs.map((c, i, all) => (
          <span key={c.id} className="contents">
            <ChevronRight aria-hidden size={13} className="faint" />
            <button type="button" onClick={() => setAt(c.id)} aria-current={i === all.length - 1 ? "location" : undefined}>
              {isolate(name(c))}
            </button>
          </span>
        ))}
      </nav>
      {!at ? (
        <ul className="drive-pick drive-dest-list" aria-label={tr("Places")}>
          {place(root, tr("My files"), "drive")}
          {(usage?.teams ?? []).map((t) => place(t.id, t.name, "folder"))}
        </ul>
      ) : list.isPending ? (
        <Spinner label={tr("Opening the folder")} />
      ) : list.error ? (
        <p className="muted">{isolate(errorMessage(list.error))}</p>
      ) : (
        <>
          {folders.length ? (
            <ul className="drive-pick drive-dest-list" aria-label={tr("Folders")}>
              {folders.map((f) => place(f.id, shownName(f.name), "folder"))}
            </ul>
          ) : (
            <p className="muted drive-dest-empty">{tr("No folders in here.")}</p>
          )}
          {list.hasNextPage && (
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {tr("Show more folders")}
            </Button>
          )}
        </>
      )}
    </Dialog>
  );
}
