// Moving bytes: downloads (a file as it is; a folder or several things as one zip file) and uploads
// (what was dropped or chosen, a name that is taken, large files in parts). Loaded when the person
// first downloads or uploads, not with the page.

import { ApiError, api, download as save, errorMessage, shell, uploadInParts, t } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { each, told } from "./bulk";
import { type Choice, nameKey } from "./clash";
import { type Found, type Tree, describe } from "./dropped";
import { type Item, isLiveDoc, shownName } from "./files";
import { uploadTree } from "./upload";

export interface Where {
  id: string;
  name: string;
}

const files = (n: number) => (n === 1 ? "1 file" : t("{n} files", { n }));
const say = (said: { message: string; error: boolean }) => toast(said.message, said.error ? "error" : "success");

/** The most items one zip is asked for at a time (the server's own cap is on size). */
export const ZIP_MOST_ITEMS = 200;

/** A zip of what is asked for, downloaded. A server that cannot make one is said so, and files go one by one. */
export async function zip(list: Item[]) {
  if (list.length > ZIP_MOST_ITEMS) return toast(t("That is more than {n} items at once. Choose fewer, or download a folder.", { n: ZIP_MOST_ITEMS }), "error");
  const ids = list.map((i) => i.id);
  const name = list.length === 1 ? `${shownName(list[0].name)}.zip` : t("Drive files.zip");
  toast(t("Preparing {name}…", { name }), "info");
  try {
    await save("/api/app/drive/archive", name, { items: ids.join(",") });
  } catch (e) {
    // An older server has no such route: files can still be downloaded one at a time.
    if (e instanceof ApiError && e.status === 404) {
      if (list.some((i) => i.kind === "folder")) return toast(t("This server cannot make a zip file of a folder yet. Download its files one at a time."), "error");
      return one(list);
    }
    toast(errorMessage(e), "error");
  }
}

/** Downloads the files one after another. */
export async function one(list: Item[]) {
  const out = await each(
    list,
    (i) => (isLiveDoc(i.name) ? save(`/api/app/drive/files/${i.id}/content`, i.name.replace(/\.fdoc$/i, ".html"), { format: "html" }) : save(`/api/app/drive/files/${i.id}/content`, i.name)),
    errorMessage,
  );
  if (out.failed.length) say(told({ done: t("Downloaded"), doing: t("download") }, out));
}


/** Downloads: a file as it is; a folder, or several things, as one zip file. */
export async function download(list: Item[]) {
  if (list.length === 1 && list[0].kind === "file") return one(list);
  return zip(list);
}

/** The names in a folder (lower-cased); `complete` is false for a folder too big to read through. */
export async function names(folder: string): Promise<{ names: Set<string>; complete: boolean }> {
  const names = new Set<string>();
  for (let offset = 0; offset < 2000; offset += 200) {
    const r = await api.get<{ items: { name: string }[]; total: number }>("/api/app/drive/list_folder", { folder, limit: 200, offset: offset || undefined });
    r.items.forEach((i) => names.add(nameKey(i.name)));
    if (offset + 200 >= r.total) return { names, complete: true };
  }
  return { names, complete: false };
}

/** Uploads what was dropped or chosen into a folder; the shell carries on with the files. */
export async function upload(o: { act: (action: string, body: Record<string, unknown>) => Promise<unknown>; after: () => Promise<unknown>; most: number | null; carries: number | null }, tree: Tree, to: Where, choices?: Map<string, Choice>, skipped = 0) {
  if (!tree.files.length && !tree.dirs.length) return;
  toast(t("Uploading {tree} to “{name}”", { tree: describe(tree), name: to.name }), "info");
  const on = (f: Found) => (f.path.length === 0 && choices?.get(nameKey(f.file.name)) === "replace" ? ("replace" as const) : ("keep_both" as const));
  try {
    const made = await uploadTree(tree, to.id, o.most, {
      makeFolder: (parent, name) => o.act("create_folder", { parent, name }) as Promise<{ id: string }>,
      send: (file, folder, label, clash) => shell().uploads.start({ file, url: `/api/app/drive/upload?${new URLSearchParams({ folder, name: file.name, on_conflict: clash })}`, label }),
      // Past the most a request carries: in parts that survive a dropped connection (and, chosen
      // again after a reload, go on from where they stood), then adopted into the folder.
      carries: o.carries,
      sendLarge: (file, folder, _label, clash) => ({
        done: uploadInParts(file).then((stored) => api.post(`/api/app/drive/adopt?${new URLSearchParams({ folder, name: file.name, file: stored.id, on_conflict: clash })}`)),
      }),
      clash: on,
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
    if (skipped) toast(skipped === 1 ? t("1 file skipped: its name was taken") : t("{n} files skipped: their names were taken", { n: skipped }), "info");
    await o.after();
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}
