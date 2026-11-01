// Putting what was dropped or chosen into Drive: the folders first, outermost first, then each file
// into the folder it sat in, handed to the shell, which carries on with it if the person moves to
// another page. What cannot be uploaded is left out with the reason. Pure apart from the two things
// it is given to do, so it is tested without a browser.

import { type Tree, creationOrder, keyOf } from "./dropped";
import { sizeLabel } from "./files";

export interface UploadDeps {
  /** Makes a folder in `parent`; answers its id (a taken name becomes `name (2)`, which is why). */
  makeFolder: (parent: string, name: string) => Promise<{ id: string }>;
  /** Hands a file to the shell for the folder. It answers when the file is taken; `done` settles
   *  when it is stored. (Not a promise of a promise: that would wait for the file to be stored.) */
  send: (file: File, folder: string, label: string) => Promise<{ done: Promise<unknown> }>;
  /** An error in words. */
  reason: (e: unknown) => string;
}

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
    if (!folder) left.push({ name: label, reason: failed.get(keyOf(path)) ?? "its folder could not be made" });
    else if (most && file.size > most) left.push({ name: label, reason: `it is ${sizeLabel(file.size)} and the most Drive takes is ${sizeLabel(most)}` });
    else sent.push({ name: label, done: (await deps.send(file, folder, label)).done });
  }
  return { sent, left, folders: ids.size - 1 };
}
