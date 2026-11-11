// Putting what was dropped or chosen into Drive: the folders first, outermost first, then each file
// into the folder it sat in, handed to the shell, which carries on with it if the person moves to
// another page. A file past the most a request carries goes to the platform in parts that survive a
// dropped connection, and Drive adopts it, when that is offered. What cannot be uploaded is left
// out with the reason. Pure apart from the things it is given to do, so it is tested without a
// browser.

import { type Found, type Tree, creationOrder, keyOf } from "./dropped";
import { sizeLabel } from "./files";
import { t } from "@ferrum/client";

export interface UploadDeps {
  /** Makes a folder in `parent`; answers its id (a taken name becomes `name (2)`, which is why). */
  makeFolder: (parent: string, name: string) => Promise<{ id: string }>;
  /** Hands a file to the shell for the folder. It answers when the file is taken; `done` settles
   *  when it is stored. (Not a promise of a promise: that would wait for the file to be stored.) */
  send: (file: File, folder: string, label: string, on: OnClash) => Promise<{ done: Promise<unknown> }>;
  /** The most one upload request carries: a file past it goes through `sendLarge`, or is left out. */
  carries?: number | null;
  /** Sends a file in parts and has Drive adopt it, for one past `carries`. */
  sendLarge?: (file: File, folder: string, label: string, on: OnClash) => { done: Promise<unknown> };
  /** What to do when the file's name is taken in its folder: keep both (the default) or add it as a new version of the one there. */
  clash?: (found: Found) => OnClash;
  /** An error in words. */
  reason: (e: unknown) => string;
}

/** The server's `on_conflict` for an upload. */
export type OnClash = "keep_both" | "replace";

export interface Sent {
  name: string;
  done: Promise<unknown>;
}

export interface Left {
  name: string;
  reason: string;
}

/** Uploads a tree into the folder `to`. `most` is the largest file the workspace takes, if known. */
export async function uploadTree(tree: Tree, to: string, most: number | null, deps: UploadDeps): Promise<{ sent: Sent[]; left: Left[]; folders: number }> {
  const ids = new Map<string, string>([["", to]]);
  const failed = new Map<string, string>();
  for (const dir of creationOrder(tree.dirs)) {
    const key = keyOf(dir);
    const parent = ids.get(keyOf(dir.slice(0, -1)));
    if (!parent) {
      failed.set(key, failed.get(keyOf(dir.slice(0, -1))) ?? "its folder could not be made");
      continue;
    }
    try {
      ids.set(key, (await deps.makeFolder(parent, dir[dir.length - 1])).id);
    } catch (e) {
      failed.set(key, deps.reason(e));
    }
  }
  const sent: Sent[] = [];
  const left: Left[] = [];
  for (const { path, file } of tree.files) {
    const folder = ids.get(keyOf(path));
    const label = [...path, file.name].join("/");
    const on = deps.clash?.({ path, file }) ?? "keep_both";
    if (!folder) left.push({ name: label, reason: failed.get(keyOf(path)) ?? t("its folder could not be made") });
    else if (most && file.size > most) left.push({ name: label, reason: t("it is {value} and the most Drive takes is {most}", { value: sizeLabel(file.size), most: sizeLabel(most) }) });
    else if (deps.carries && file.size > deps.carries && deps.sendLarge) sent.push({ name: label, done: deps.sendLarge(file, folder, label, on).done });
    else if (deps.carries && file.size > deps.carries) left.push({ name: label, reason: t("it is {value} and one upload carries at most {value2}", { value: sizeLabel(file.size), value2: sizeLabel(deps.carries) }) });
    else sent.push({ name: label, done: (await deps.send(file, folder, label, on)).done });
  }
  return { sent, left, folders: ids.size - 1 };
}
