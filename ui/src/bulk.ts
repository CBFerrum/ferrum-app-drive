// Acting on several items at once: one after another (a move locks the folders it touches), every
// one tried, and what happened told in words. Pure, so it is tested without a browser.

export interface Outcome<T> {
  done: T[];
  failed: { item: T; reason: string }[];
}

/** Runs `run` on each item in turn; one that fails does not stop the rest. `reason` puts an
 *  error in words (the server's own). */
export async function each<T>(items: T[], run: (item: T) => Promise<unknown>, reason: (e: unknown) => string): Promise<Outcome<T>> {
  const out: Outcome<T> = { done: [], failed: [] };
  for (const item of items) {
    try {
      await run(item);
      out.done.push(item);
    } catch (e) {
      out.failed.push({ item, reason: reason(e) });
    }
  }
  return out;
}

export const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** What a run did: "Moved 3 items to “Reports”", or what went wrong, with the server's reason for
 *  the first that failed. `verb` is what was done ("Moved") and `doing` what was tried ("move");
 *  `where` finishes the sentence ("to “Reports”"). `noun` is what the things are called. */
export function told(verb: { done: string; doing: string }, out: Outcome<{ name: string }>, where?: string, noun = items): { message: string; error: boolean } {
  const total = out.done.length + out.failed.length;
  const to = where ? ` ${where}` : "";
  if (!out.failed.length) return { message: `${verb.done} ${noun(total)}${to}`, error: false };
  const [first] = out.failed;
  const more = out.failed.length > 1 ? ` (and ${out.failed.length - 1} more)` : "";
  const head = out.done.length ? `${verb.done} ${out.done.length} of ${noun(total)}${to}. ` : `Could not ${verb.doing} “${first.item.name}”: `;
  return { message: out.done.length ? `${head}“${first.item.name}”: ${first.reason}${more}` : `${head}${first.reason}${more}`, error: true };
}
