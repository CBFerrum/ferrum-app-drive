import { t } from "@ferrum/client";
// Files and folders dropped from the computer (or chosen with the folder picker): the folders to
// make in Drive, outermost first, and the files to put in them. Pure, so it is tested without a
// browser; the browser's own types are asked for only what this needs.

/** The part of the browser's `FileSystemEntry` this reads. */
export interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, fail?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: Entry[]) => void, fail?: (error: unknown) => void) => void };
}

/** A file and the folders above it, relative to where it was dropped. */
export interface Found {
  path: string[];
  file: File;
}

export interface Tree {
  /** Every folder, the outermost first, empty ones too. */
  dirs: string[][];
  files: Found[];
}

/** One drop takes at most this many files: more would swamp the page and the upload tray. */
export const MOST_FILES = 1000;

export class TooMany extends Error {
  constructor() {
    super(t("That is more than {MOST_FILES} files at once. Drop fewer, or put them in a zip file.", { MOST_FILES: MOST_FILES.toLocaleString() }));
  }
}

/** What an operating system leaves in folders that nobody means to upload. */
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;

const readAll = (reader: NonNullable<ReturnType<NonNullable<Entry["createReader"]>>>): Promise<Entry[]> =>
  new Promise((resolve, reject) => {
    const all: Entry[] = [];
    // A reader gives its entries in batches (a hundred at a time in Chrome) until it gives none.
    const more = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        more();
      }, reject);
    more();
  });

const fileOf = (e: Entry): Promise<File> => new Promise((resolve, reject) => (e.file ? e.file(resolve, reject) : reject(new Error(t("{name} cannot be read", { name: e.name })))));

/** Everything under `entries`: their files with the folders above them, and those folders. */
export async function walk(entries: Entry[]): Promise<Tree> {
  const tree: Tree = { dirs: [], files: [] };
  const visit = async (e: Entry, path: string[]) => {
    if (e.isFile) {
      if (JUNK.test(e.name)) return;
      if (tree.files.length >= MOST_FILES) throw new TooMany();
      tree.files.push({ path, file: await fileOf(e) });
    } else if (e.isDirectory && e.createReader) {
      const here = [...path, e.name];
      tree.dirs.push(here);
      for (const child of await readAll(e.createReader())) await visit(child, here);
    }
  };
  for (const e of entries) await visit(e, []);
  return tree;
}

/** The files the folder picker gave: each says where it sits in the chosen folder
 *  (`webkitRelativePath`, `Photos/2024/a.jpg`). */
export function fromPicker(files: ArrayLike<File & { webkitRelativePath?: string }>): Tree {
  const tree: Tree = { dirs: [], files: [] };
  const seen = new Set<string>();
  for (const file of Array.from(files)) {
    if (JUNK.test(file.name)) continue;
    if (tree.files.length >= MOST_FILES) throw new TooMany();
    const parts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    const path = parts.slice(0, -1);
    for (let n = 1; n <= path.length; n++) {
      const key = path.slice(0, n).join("/");
      if (!seen.has(key)) {
        seen.add(key);
        tree.dirs.push(path.slice(0, n));
      }
    }
    tree.files.push({ path, file });
  }
  return tree;
}

/** The entries of a drop, taken out of the event at once: the browser empties its list when the
 *  handler returns. A browser that cannot read folders gives its files alone. */
export function entriesOf(dt: DataTransfer): Entry[] {
  const out: Entry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) out.push(entry);
    else {
      const file = item.getAsFile();
      if (file) out.push({ isFile: true, isDirectory: false, name: file.name, file: (ok) => ok(file) });
    }
  }
  return out;
}

/** The key of a folder's path. */
export const keyOf = (path: string[]) => path.join("/");

/** The folders in the order they can be made (each after the one holding it). */
export function creationOrder(dirs: string[][]): string[][] {
  return [...dirs].sort((a, b) => a.length - b.length);
}

/** How a drop reads: "3 files and 2 folders". */
export function describe(tree: Tree): string {
  const files = tree.files.length === 1 ? "1 file" : t("{length} files", { length: tree.files.length });
  const dirs = tree.dirs.length === 1 ? "1 folder" : t("{length} folders", { length: tree.dirs.length });
  return tree.dirs.length ? t("{files} in {dirs}", { files, dirs }) : files;
}
