// Choosing several items in a list to act on all of them: a click, Shift for a stretch, Ctrl or
// Command to add or take one. Pure, so it is tested without a browser.

export interface Chosen {
  selected: ReadonlySet<string>;
  /** Where a Shift-click stretches from: the item chosen last. */
  anchor: string | null;
}

export const NOTHING: Chosen = { selected: new Set(), anchor: null };

/** `from` to `to` in the list's order, both included (either may come first). */
export function between(ids: readonly string[], from: string, to: string): string[] {
  const [a, b] = [ids.indexOf(from), ids.indexOf(to)];
  if (a < 0 || b < 0) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The choice after clicking `id`'s box: a plain click adds or takes that item; with `shift`, the
 *  stretch from the anchor is added (or, when `id` was chosen already, taken). */
export function click(now: Chosen, ids: readonly string[], id: string, shift: boolean): Chosen {
  const next = new Set(now.selected);
  if (shift && now.anchor && now.anchor !== id) {
    const stretch = between(ids, now.anchor, id);
    const on = !now.selected.has(id);
    for (const s of stretch) (on ? next.add(s) : next.delete(s));
    return { selected: next, anchor: id };
  }
  if (!next.delete(id)) next.add(id);
  return { selected: next, anchor: id };
}

export const all = (ids: readonly string[]): Chosen => ({ selected: new Set(ids), anchor: ids[ids.length - 1] ?? null });

/** Only what is still in the list (an item moved away or deleted is no longer chosen). */
export function keep(now: Chosen, ids: readonly string[]): Chosen {
  if ([...now.selected].every((s) => ids.includes(s))) return now;
  const present = new Set(ids);
  const selected = new Set([...now.selected].filter((s) => present.has(s)));
  return { selected, anchor: now.anchor && present.has(now.anchor) ? now.anchor : null };
}

/** What a command acts on: the choice when the item in focus is part of it, else the item in
 *  focus alone, else the choice. */
export function targets(chosen: ReadonlySet<string>, focus: string | null, ids: readonly string[]): string[] {
  if (focus && !chosen.has(focus)) return ids.includes(focus) ? [focus] : [];
  return ids.filter((i) => chosen.has(i));
}
