// What a person does with Drive's items, one or many: move, copy, trash, restore, star, download,
// upload. Each acts on a list one item after another, shows the result at once and takes it back,
// with the server's reason, for an item the server refused; then the lists are fetched again.

import { api, download, errorMessage, shell, uploadInParts, t } from "@ferrum/client";
import { confirmDialog, toast } from "@ferrum/kit";
import { type Outcome, each, items as count, told } from "./bulk";
import { type Tree, describe } from "./dropped";
import { type Item, isLiveDoc, shownName } from "./files";
import { uploadTree } from "./upload";

export interface Where {
  id: string;
  name: string;
}

const files = (n: number) => (n === 1 ? "1 file" : t("{n} files", { n }));

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
}) {
  const act = (action: string, body: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${o.space}/actions/${action}`, body);
  const ids = (list: Item[]) => list.map((i) => i.id);
  const failedIds = (out: Outcome<Item>) => out.failed.map((f) => f.item.id);

  /** Runs `action` on each item, the items gone from the lists meanwhile, and says how it went. */
  async function run(list: Item[], action: (i: Item) => Promise<unknown>, verb: { done: string; doing: string }, where?: string, leave = true) {
    if (leave) o.hide(ids(list));
    const out = await each(list, action, errorMessage);
    o.show(failedIds(out));
    say(told(verb, out, where));
    await o.after();
    o.show(ids(out.done));
    return out;
  }

  return {
    act,

    /** Asks first (a keyboard can do this by accident), then moves the items to the trash. */
    async trash(list: Item[]) {
      if (!list.length) return;
      const ok = await confirmDialog({ title: t("Move {list} to the trash?", { list: called(list) }), message: t("You can restore them from Trash."), confirmLabel: t("Move to trash"), danger: true });
      if (ok) await run(list, (i) => act("trash", { item: i.id }), { done: t("Moved"), doing: t("trash") }, t("to the trash"));
    },

    async restore(list: Item[]) {
      await run(list, (i) => act("restore", { item: i.id }), { done: t("Restored"), doing: t("restore") });
    },

    async destroy(list: Item[]) {
      const ok = await confirmDialog({ title: t("Delete {list} for good?", { list: called(list) }), message: t("This cannot be undone."), confirmLabel: t("Delete forever"), danger: true });
      if (ok) await run(list, (i) => act("delete_forever", { item: i.id }), { done: t("Deleted"), doing: t("delete") });
    },

    async emptyTrash() {
      const ok = await confirmDialog({ title: t("Empty the trash?"), message: t("Everything in it is deleted for good. This cannot be undone."), confirmLabel: t("Empty the trash"), danger: true });
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

    /** Moves the items into a folder, or copies them. */
    async move(list: Item[], to: Where, copy: boolean) {
      return run(list, (i) => act(copy ? "copy" : "move", { item: i.id, to: to.id }), copy ? { done: t("Copied"), doing: t("copy") } : { done: t("Moved"), doing: t("move") }, t("to “{name}”", { name: to.name }), !copy);
    },

    /** Stars them all, or, when every one is starred already, takes the stars off. */
    async star(list: Item[]) {
      const off = list.every((i) => i.starred);
      const out = await each(list.filter((i) => off || !i.starred), (i) => act(off ? "unstar" : "star", { item: i.id }), errorMessage);
      if (out.failed.length) say(told({ done: off ? "Unstarred" : "Starred", doing: off ? "unstar" : "star" }, out));
      await o.after();
    },

    /** Downloads the files one after another; folders cannot be downloaded. */
    async download(list: Item[]) {
      const only = list.filter((i) => i.kind === "file");
      if (!only.length) return toast(t("Only files can be downloaded"), "error");
      const out = await each(
        only,
        (i) => (isLiveDoc(i.name) ? download(`/api/app/drive/files/${i.id}/content`, i.name.replace(/\.fdoc$/i, ".html"), { format: "html" }) : download(`/api/app/drive/files/${i.id}/content`, i.name)),
        errorMessage,
      );
      if (out.failed.length) say(told({ done: t("Downloaded"), doing: t("download") }, out));
      else if (only.length < list.length) toast(t("Downloaded {value}. Folders cannot be downloaded.", { value: files(only.length) }));
    },

    /** Uploads what was dropped or chosen into a folder; the shell carries on with the files. */
    async upload(tree: Tree, to: Where) {
      if (!tree.files.length && !tree.dirs.length) return;
      toast(t("Uploading {tree} to “{name}”", { tree: describe(tree), name: to.name }));
      try {
        const made = await uploadTree(tree, to.id, o.most, {
          makeFolder: (parent, name) => act("create_folder", { parent, name }) as Promise<{ id: string }>,
          send: (file, folder, label) => shell().uploads.start({ file, url: `/api/app/drive/upload?${new URLSearchParams({ folder, name: file.name })}`, label }),
          // Past the most a request carries: in parts that survive a dropped connection (and, chosen
          // again after a reload, go on from where they stood), then adopted into the folder.
          carries: o.carries ?? null,
          sendLarge: (file, folder) => ({
            done: uploadInParts(file).then((stored) => api.post(`/api/app/drive/adopt?${new URLSearchParams({ folder, name: file.name, file: stored.id })}`)),
          }),
          reason: errorMessage,
        });
        if (made.left.length) {
          const [first] = made.left;
          toast((made.left.length > 1 ? t("“{name}” was left out: {reason} (and {value1} more)", { name: first.name, reason: first.reason, value1: made.left.length - 1 }) : t("“{name}” was left out: {reason}", { name: first.name, reason: first.reason })), "error");
        }
        // One word on the whole upload when the last file is stored (the tray tells each one).
        const results = await Promise.allSettled(made.sent.map((s) => s.done));
        const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ item: made.sent[i], reason: errorMessage(r.reason) }] : []));
        if (made.sent.length) say(told({ done: t("Uploaded"), doing: t("upload") }, { done: made.sent.filter((_, i) => results[i].status === "fulfilled"), failed }, t("to “{name}”", { name: to.name }), files));
        await o.after();
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    },
  };
}
