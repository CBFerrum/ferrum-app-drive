// A name taken: which of the files being uploaded have the name of a file in the folder already, and
// what the person said to do about each. Pure, so it is tested without a browser.

import type { Found } from "./dropped";

/** keep both (the new one is numbered), replace (the new one becomes the file's newest version) or skip it. */
export type Choice = "both" | "replace" | "skip";

/** How Drive compares names: ignoring case, as the server does. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** The files of a drop whose name is taken in the folder they go to. Files inside dropped folders go into folders made for them: they never clash. */
export function clashes(files: Found[], taken: ReadonlySet<string>): Found[] {
  return files.filter((f) => f.path.length === 0 && taken.has(nameKey(f.file.name)));
}

/** The choices for `names` when the person answers one at a time, or once for all. */
export function decide(names: string[], answers: { name?: string; choice: Choice; all: boolean }[]): Map<string, Choice> {
  const out = new Map<string, Choice>();
  for (const a of answers) {
    if (a.all) for (const n of names) out.has(nameKey(n)) || out.set(nameKey(n), a.choice);
    else if (a.name) out.set(nameKey(a.name), a.choice);
  }
  return out;
}
