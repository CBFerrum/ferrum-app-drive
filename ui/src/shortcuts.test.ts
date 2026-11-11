import { describe, expect, it } from "vitest";
import { commandFor, typing } from "./shortcuts";
import { SHORTCUTS, keyName } from "./shortcutHelp";

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  commandFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("Drive's keys", () => {
  it("means one command by each key", () => {
    expect(["?", "/", "j", "ArrowDown", "k", "ArrowUp", "Home", "End", "Enter", " ", "x", "Escape", "ArrowLeft", "ArrowRight", "F2", "Delete", "Backspace", "s", "d", "m", "c", "h", "n", "u"].map((k) => press(k))).toEqual([
      "help",
      "search",
      "next",
      "next",
      "previous",
      "previous",
      "first",
      "last",
      "open",
      "preview",
      "choose",
      "clear",
      "left",
      "right",
      "rename",
      "trash",
      "trash",
      "star",
      "details",
      "move",
      "copy",
      "share",
      "folder",
      "upload",
    ]);
  });

  it("chooses everything with Ctrl or Command and A, and leaves the browser's own shortcuts alone", () => {
    expect(press("a", { ctrlKey: true })).toBe("all");
    expect(press("A", { metaKey: true })).toBe("all");
    expect([press("c", { ctrlKey: true }), press("X", { metaKey: true }), press("v", { ctrlKey: true })]).toEqual(["clipcopy", "clipcut", "paste"]);
    expect(press("s", { metaKey: true })).toBeNull();
    expect(press("d", { ctrlKey: true })).toBeNull();
    expect(press("k", { metaKey: true })).toBeNull();
    expect(press("m", { altKey: true })).toBeNull();
    expect(press("a", { ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("ignores keys it has no use for", () => {
    expect([press("q"), press("Tab"), press("1")]).toEqual([null, null, null]);
  });

  it("lists each command's key in its help, and names Mod for the keyboard", () => {
    const keys = SHORTCUTS.flatMap((g) => g.keys.flatMap((s) => s.keys));
    for (const k of ["j", "k", "x", "m", "c", "h", "s", "F2", "d", "Delete", "n", "u", "?", "/", "Esc"]) expect(keys, k).toContain(k);
    expect(keyName("Mod", true)).toBe("⌘");
    expect(keyName("Mod", false)).toBe("Ctrl");
    expect(keyName("j", false)).toBe("j");
  });

  it("does not take keys typed into a field", () => {
    const inside = (selector: string) => ({ closest: (s: string) => (s.split(", ").includes(selector) ? {} : null) }) as unknown as EventTarget;
    expect(typing(inside("input:not([type='checkbox'])"))).toBe(true);
    expect(typing(inside("textarea"))).toBe(true);
    expect(typing(inside("[role='menu']"))).toBe(true);
    expect(typing(inside("dialog[open]"))).toBe(true);
    expect(typing(inside("div"))).toBe(false);
    expect(typing(null)).toBe(false);
  });
});
