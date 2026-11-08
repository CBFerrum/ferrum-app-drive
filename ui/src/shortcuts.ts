// Drive's keys: what each does, which key press means which, and the list the help dialog shows.
// Pure, so it is tested without a browser.

import { t } from "@ferrum/client";
export type Command =
  | "help"
  | "search"
  | "next"
  | "previous"
  | "first"
  | "last"
  | "open"
  | "choose"
  | "all"
  | "clear"
  | "rename"
  | "trash"
  | "star"
  | "details"
  | "move"
  | "copy"
  | "share"
  | "folder"
  | "upload";

type KeyPress = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** The command a key press means, if any. Letters work on their own (never with Ctrl, Command or
 *  Alt), because the page asks for them only when no field has the focus. */
export function commandFor(e: KeyPress): Command | null {
  if (e.ctrlKey || e.metaKey) return e.key.toLowerCase() === "a" && !e.altKey && !e.shiftKey ? "all" : null;
  if (e.altKey) return null;
  switch (e.key) {
    case "?":
      return "help";
    case "/":
      return "search";
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowUp":
    case "k":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "open";
    case " ":
    case "x":
      return "choose";
    case "Escape":
      return "clear";
    case "F2":
      return "rename";
    case "Delete":
    case "Backspace":
      return "trash";
    case "s":
      return "star";
    case "d":
      return "details";
    case "m":
      return "move";
    case "c":
      return "copy";
    case "h":
      return "share";
    case "n":
      return "folder";
    case "u":
      return "upload";
    default:
      return null;
  }
}

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
      { get keys() { return [t("Enter")]; }, get does() { return t("Open"); } },
      { keys: ["/"], get does() { return t("Search"); } },
    ],
  },
  {
    get group() { return t("Choose"); },
    keys: [
      { keys: ["x", "Space"], get does() { return t("Choose or unchoose the item"); } },
      { keys: ["Mod+A"], get does() { return t("Choose every item shown"); } },
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

/** Whether a key press happens in a place that wants its keys for itself: a field, a dialog, a menu. */
export function typing(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || !("closest" in el)) return false;
  return !!el.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='listbox'], [role='dialog'], dialog[open]");
}
