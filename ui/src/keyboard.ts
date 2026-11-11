// Drive's keys in the list and the grid: what each command does to the page. The page loads this
// after it has drawn (a key pressed in the first moments does nothing), so the page itself is
// lighter. It acts on the page through the `PageKeys` it is handed.

import { t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { type Chosen, NOTHING, all as chooseEvery, click, targets } from "./selection";
import { type Item, allows, shownName } from "./files";
import type { Command } from "./shortcuts";

/** What the keys need to know of the page and can do to it. */
export interface PageKeys {
  items: Item[];
  ids: string[];
  chosen: Chosen;
  view: string;
  layout: "list" | "grid";
  places: boolean;
  selected: string | null;
  canAdd: boolean;
  target: string | undefined;
  targetName: string;
  clipboard: { current: { items: Item[]; cut: boolean } | null };
  actions: { trash: (l: Item[]) => Promise<unknown>; star: (l: Item[]) => Promise<unknown>; move: (l: Item[], to: { id: string; name: string }, copy: boolean) => Promise<unknown> };
  openItem: (it: Item) => void;
  pick: (next: Record<string, string | null>) => void;
  newFolder: () => void;
  focusSearch: () => void;
  chooseUpload: () => void;
  setHelping: (on: boolean) => void;
  setChosen: (next: Chosen | ((c: Chosen) => Chosen)) => void;
  setPlaces: (on: boolean) => void;
  setRenaming: (id: string) => void;
  setMoving: (m: { items: Item[]; copy: boolean }) => void;
  setSharing: (it: Item) => void;
  setSharingMany: (l: Item[]) => void;
}

/** The row to move the focus to, in the order of the list. */
const rowOf = (el: Element | null) => el?.closest<HTMLElement>("[data-row]")?.dataset.row ?? null;

/** How many cards sit in one row of the grid now (it follows the width of the page). */
const columnsOf = () => {
  const grid = document.querySelector(".drive-grid");
  return grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length) : 1;
};

export function runCommand(e: KeyboardEvent, command: Command, c: PageKeys) {
  const { items, ids, chosen, view, layout, places, selected, canAdd, target, targetName, clipboard, actions, openItem, pick, newFolder, setHelping, setChosen, setPlaces, setRenaming, setMoving, setSharing, setSharingMany } = c;
  const at = e.target as Element;
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
        return c.focusSearch();
      case "left":
      case "right":
      case "next":
      case "previous":
      case "first":
      case "last": {
        if (!ids.length) return;
        // In the grid the arrows go across and down the cards; in the list left and right do nothing.
        const grid = layout === "grid";
        if ((command === "left" || command === "right") && !grid) return;
        stop();
        const now = focus ? ids.indexOf(focus) : -1;
        // The arrow keys go a row at a time; j and k, one card.
        const columns = grid && e.key.startsWith("Arrow") ? columnsOf() : 1;
        const by = command === "left" ? -1 : command === "right" ? 1 : command === "next" ? columns : command === "previous" ? -columns : 0;
        const rtl = getComputedStyle(document.documentElement).direction === "rtl";
        const step = command === "left" || command === "right" ? (rtl ? -by : by) : by;
        const to = command === "first" ? 0 : command === "last" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, (now < 0 ? (step < 0 ? ids.length : -1) : now) + step));
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
      case "preview": {
        // Space on a button or a box does its own thing; on the row itself it shows the file.
        const [it] = at.closest("input, button") ? [] : acting();
        if (!it || it.kind !== "file" || bin) return;
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
      case "clipcopy":
      case "clipcut": {
        // A selection of text on the page is the browser's to copy.
        if (window.getSelection()?.toString()) return;
        const list = acting();
        if (!list.length || bin) return;
        if (command === "clipcut" && !list.every((i) => allows(i.permission, "Edit"))) return toast(tr("You cannot move these: you may only change what you can edit."), "error");
        stop();
        clipboard.current = { items: list, cut: command === "clipcut" };
        return toast(command === "clipcut" ? tr("Cut {value}. Open a folder and press Ctrl+V to move them there.", { value: list.length === 1 ? `“${shownName(list[0].name)}”` : tr("{n} items", { n: list.length }) }) : tr("Copied {value}. Open a folder and press Ctrl+V to paste them there.", { value: list.length === 1 ? `“${shownName(list[0].name)}”` : tr("{n} items", { n: list.length }) }), "info");
      }
      case "paste": {
        const held = clipboard.current;
        if (!held || bin) return;
        stop();
        if (!target || !canAdd) return toast(tr("You cannot add files here"), "error");
        if (held.cut) clipboard.current = null;
        return void actions.move(held.items, { id: target, name: targetName }, !held.cut);
      }
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
        return c.chooseUpload();
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
          setRenaming(list[0].id);
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
}
