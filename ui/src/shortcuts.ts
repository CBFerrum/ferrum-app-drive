// Drive's keys: what each does, which key press means which, and the list the help dialog shows.
// Pure, so it is tested without a browser.

export type Command =
  | "help"
  | "search"
  | "next"
  | "previous"
  | "first"
  | "last"
  | "left"
  | "right"
  | "open"
  | "preview"
  | "choose"
  | "all"
  | "clipcopy"
  | "clipcut"
  | "paste"
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
  if (e.ctrlKey || e.metaKey) {
    if (e.altKey || e.shiftKey) return null;
    const key = e.key.toLowerCase();
    return key === "a" ? "all" : key === "c" ? "clipcopy" : key === "x" ? "clipcut" : key === "v" ? "paste" : null;
  }
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
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "open";
    case " ":
      return "preview";
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

/** Whether a key press happens in a place that wants its keys for itself: a field, a dialog, a menu. */
export function typing(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || !("closest" in el)) return false;
  // A box that is ticked is not a field: the keys still mean what they mean once an item is chosen with it.
  return !!el.closest("input:not([type='checkbox']), textarea, select, [contenteditable='true'], [role='menu'], [role='listbox'], [role='dialog'], dialog[open]");
}
