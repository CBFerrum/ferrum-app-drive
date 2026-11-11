// What a person does with Drive's items, one or many: move, copy, trash, restore, star, rename,
// download (a folder or several things as one zip file), upload, upload a new version. Each acts on a
// list one item after another, shows the result at once and takes it back, with the server's reason,
// for an item the server refused; then the lists are fetched again. What can be taken back says so
// (the page offers Undo).

import { api, errorMessage, t } from "@ferrum/client";
import { confirmDialog, toast } from "@ferrum/kit";
import { type Outcome, each, items as count, told } from "./bulk";
import type { Choice } from "./clash";
import type { Tree } from "./dropped";
import { type Item, isLiveDoc, shownName } from "./files";

export interface Where {
  id: string;
  name: string;
}

/** What a confirmation calls the items: their name, or how many. */
const called = (list: Item[]) => (list.length === 1 ? `“${shownName(list[0].name)}”` : count(list.length));

const say = (said: { message: string; error: boolean }) => toast(said.message, said.error ? "error" : "success");

export function useActions(o: {
  space: string | undefined;
  /** Items to leave out of the lists at once, and to bring back. */
  hide: (ids: string[]) => void;
  show: (ids: string[]) => void;
  /** Fetches the lists again. */
  after: () => Promise<unknown>;
  /** The most one file may be, if known. */
  most: number | null;
  /** The most one upload request carries, if known: past it a file goes in parts and is adopted. */
  carries?: number | null;
  /** A toast that can be taken back. `undo` answers what to say when it is done. */
  offer?: (message: string, undo: () => Promise<string>) => void;
}) {
  const act = (action: string, body: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${o.space}/actions/${action}`, body);
  const ids = (list: Item[]) => list.map((i) => i.id);
  const failedIds = (out: Outcome<Item>) => out.failed.map((f) => f.item.id);

  /** Runs `action` on each item, the items gone from the lists meanwhile, and says how it went. With `undo`, what went right can be taken back. */
  async function run(list: Item[], action: (i: Item) => Promise<unknown>, verb: { done: string; doing: string }, where?: string, leave = true, undo?: (done: Item[]) => Promise<string>) {
    if (leave) o.hide(ids(list));
    const out = await each(list, action, errorMessage);
    o.show(failedIds(out));
    const said = told(verb, out, where);
    if (undo && !out.failed.length && o.offer) o.offer(said.message, () => undo(out.done));
    else say(said);
    await o.after();
    o.show(ids(out.done));
    return out;
  }

  /** Puts items back where they were (their `parent` when they were picked up), one by one. */
  const putBack = async (list: Item[]) => {
    const out = await each(list.filter((i) => i.parent), (i) => act("move", { item: i.id, to: i.parent }), errorMessage);
    await o.after();
    return out.failed.length ? told({ done: t("Moved back"), doing: t("move back") }, out).message : t("Moved back {value}", { value: count(out.done.length) });
  };

  return {
    act,

    /** Moves the items to the trash; the toast says so and offers Undo (a key can do this by accident, so nothing is lost by it). */
    async trash(list: Item[]) {
      if (!list.length) return;
      await run(list, (i) => act("trash", { item: i.id }), { done: t("Moved"), doing: t("trash") }, t("to the trash"), true, async (done) => {
        const out = await each(done, (i) => act("restore", { item: i.id }), errorMessage);
        await o.after();
        return out.failed.length ? told({ done: t("Restored"), doing: t("restore") }, out).message : t("Restored {value}", { value: count(out.done.length) });
      });
    },

    async restore(list: Item[]) {
      await run(list, (i) => act("restore", { item: i.id }), { done: t("Restored"), doing: t("restore") });
    },

    async destroy(list: Item[]) {
      const ok = await confirmDialog({ title: t("Delete {list} for good?", { list: called(list) }), message: t("This cannot be undone."), confirmLabel: t("Delete forever"), danger: true });
      if (ok) await run(list, (i) => act("delete_forever", { item: i.id }), { done: t("Deleted"), doing: t("delete") });
    },

    /** Empties the trash after saying how many things go (`n` when it is known). */
    async emptyTrash(n?: number | null) {
      const ok = await confirmDialog({
        title: n ? t("Delete {list} in the trash for good?", { list: count(n) }) : t("Empty the trash?"),
        message: t("Everything in it is deleted for good. This cannot be undone."),
        confirmLabel: t("Empty the trash"),
        danger: true,
      });
      if (!ok) return;
      try {
        let gone = 0;
        // The server empties up to 200 items a time.
        for (let more = true; more; ) {
          const r = (await act("empty_trash", {})) as { deleted: number; more: boolean };
          gone += r.deleted;
          more = r.more && r.deleted > 0;
        }
        toast(gone ? t("Deleted {gone} for good", { gone: count(gone) }) : t("The trash was empty"));
      } catch (e) {
        toast(errorMessage(e), "error");
      }
      await o.after();
    },

    /** Moves the items into a folder, or copies them. A move is taken back by moving them back; a copy by trashing the copies. */
    async move(list: Item[], to: Where, copy: boolean) {
      const made: string[] = [];
      return run(
        list,
        async (i) => {
          const r = (await act(copy ? "copy" : "move", { item: i.id, to: to.id })) as { id?: string } | undefined;
          if (copy && r?.id) made.push(r.id);
        },
        copy ? { done: t("Copied"), doing: t("copy") } : { done: t("Moved"), doing: t("move") },
        t("to “{name}”", { name: to.name }),
        !copy,
        copy
          ? async () => {
              const out = await each(made, (id) => act("trash", { item: id }), errorMessage);
              await o.after();
              return out.failed.length ? out.failed[0].reason : t("The copies are in the trash");
            }
          : putBack,
      );
    },

    /** Gives an item a new name once the server has it; answers why not, or null. */
    async rename(it: Item, name: string): Promise<string | null> {
      try {
        const before = it.name;
        await act("rename", { item: it.id, name: isLiveDoc(it.name) ? `${shownName(name)}.fdoc` : name });
        o.offer?.(t("Renamed to “{name}”", { name }), async () => {
          await act("rename", { item: it.id, name: before });
          await o.after();
          return t("Named “{name}” again", { name: shownName(before) });
        });
        await o.after();
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    },

    /** Stars them all, or, when every one is starred already, takes the stars off. */
    async star(list: Item[]) {
      const off = list.every((i) => i.starred);
      const out = await each(list.filter((i) => off || !i.starred), (i) => act(off ? "unstar" : "star", { item: i.id }), errorMessage);
      if (out.failed.length) say(told({ done: off ? "Unstarred" : "Starred", doing: off ? "unstar" : "star" }, out));
      await o.after();
    },

    /** Downloads: a file as it is; a folder, or several things, as one zip file. */
    async download(list: Item[]) {
      if (list.length) await (await import("./transfers")).download(list);
    },

    /** The names in a folder (lower-cased), for the uploads that would meet one; `complete` is false for a folder too big to read through. */
    async names(folder: string) {
      return (await import("./transfers")).names(folder);
    },

    /** Uploads what was dropped or chosen into a folder; the shell carries on with the files. */
    async upload(tree: Tree, to: Where, choices?: Map<string, Choice>, skipped = 0) {
      await (await import("./transfers")).upload({ act, after: o.after, most: o.most, carries: o.carries ?? null }, tree, to, choices, skipped);
    },
  };
}
