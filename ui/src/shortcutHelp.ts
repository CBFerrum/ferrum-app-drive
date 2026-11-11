// The keys as the help dialog lists them, in groups (loaded with the dialog, not with the page).

import { t } from "@ferrum/client";

export interface Shortcut {
  keys: string[];
  does: string;
}

/** The keys, in the groups the help dialog shows. Keys in a list are alternatives; `Mod+A` is
 *  two keys together, `Mod` being Ctrl, or Command on a Mac. */
export const SHORTCUTS: { group: string; keys: Shortcut[] }[] = [
  {
    get group() { return t("Move around"); },
    keys: [
      { keys: ["j", "↓"], get does() { return t("Next item"); } },
      { keys: ["k", "↑"], get does() { return t("Previous item"); } },
      { get keys() { return [t("Home"), t("End")]; }, get does() { return t("Go to the first or the last item"); } },
      { keys: ["←", "→"], get does() { return t("Across the cards in the grid"); } },
      { get keys() { return [t("Enter")]; }, get does() { return t("Open"); } },
      { keys: ["Space"], get does() { return t("Preview the file"); } },
      { keys: ["/"], get does() { return t("Search"); } },
    ],
  },
  {
    get group() { return t("Choose"); },
    keys: [
      { keys: ["x"], get does() { return t("Choose or unchoose the item"); } },
      { keys: ["Mod+A"], get does() { return t("Choose every item shown"); } },
      { keys: ["Mod+C", "Mod+X"], get does() { return t("Copy or cut the chosen items"); } },
      { keys: ["Mod+V"], get does() { return t("Paste them into this folder"); } },
      { get keys() { return [t("Esc")]; }, get does() { return t("Choose nothing"); } },
    ],
  },
  {
    get group() { return t("Do"); },
    keys: [
      { keys: ["m"], get does() { return t("Move to…"); } },
      { keys: ["c"], get does() { return t("Copy to…"); } },
      { keys: ["h"], get does() { return t("Share"); } },
      { keys: ["s"], get does() { return t("Star or unstar"); } },
      { keys: ["F2"], get does() { return t("Rename"); } },
      { keys: ["d"], get does() { return t("Show details"); } },
      { get keys() { return [t("Delete")]; }, get does() { return t("Move to the trash"); } },
    ],
  },
  {
    get group() { return t("Make"); },
    keys: [
      { keys: ["n"], get does() { return t("New folder"); } },
      { keys: ["u"], get does() { return t("Upload files"); } },
      { keys: ["?"], get does() { return t("Show these keys"); } },
    ],
  },
];

/** What a key is called on this keyboard. */
export function keyName(key: string, mac: boolean): string {
  return key === "Mod" ? (mac ? "⌘" : "Ctrl") : key;
}
