import { describe, expect, it } from "vitest";
import { NOTHING, all, between, click, keep, targets } from "./selection";

const ids = ["a", "b", "c", "d", "e"];

describe("choosing several items", () => {
  it("adds and takes one item with a click", () => {
    const one = click(NOTHING, ids, "b", false);
    expect([...one.selected]).toEqual(["b"]);
    expect(one.anchor).toBe("b");
    const two = click(one, ids, "d", false);
    expect([...two.selected].sort()).toEqual(["b", "d"]);
    const back = click(two, ids, "b", false);
    expect([...back.selected]).toEqual(["d"]);
  });

  it("stretches from the item chosen last with Shift, either way", () => {
    const from = click(NOTHING, ids, "b", false);
    expect([...click(from, ids, "d", true).selected].sort()).toEqual(["b", "c", "d"]);
    expect([...click(click(NOTHING, ids, "d", false), ids, "b", true).selected].sort()).toEqual(["b", "c", "d"]);
  });

  it("takes a stretch off when it ends on an item that was chosen", () => {
    const every = all(ids);
    const less = click(click(every, ids, "b", false), ids, "d", true);
    expect([...less.selected].sort()).toEqual(["a", "e"]);
  });

  it("starts at the click when Shift has nowhere to stretch from", () => {
    expect([...click(NOTHING, ids, "c", true).selected]).toEqual(["c"]);
  });

  it("finds a stretch of the list", () => {
    expect(between(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(between(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(between(ids, "b", "gone")).toEqual(["gone"]);
  });

  it("forgets what left the list", () => {
    const chosen = all(["a", "b", "c"]);
    expect(keep(chosen, ids)).toBe(chosen);
    const after = keep(chosen, ["b", "c"]);
    expect([...after.selected]).toEqual(["b", "c"]);
    expect(after.anchor).toBe("c");
    expect(keep(chosen, ["x"]).anchor).toBeNull();
  });

  it("acts on the choice when the item in focus is in it, else on the item in focus", () => {
    const chosen = new Set(["b", "d"]);
    expect(targets(chosen, "b", ids)).toEqual(["b", "d"]);
    expect(targets(chosen, null, ids)).toEqual(["b", "d"]);
    expect(targets(chosen, "c", ids)).toEqual(["c"]);
    expect(targets(new Set(), "c", ids)).toEqual(["c"]);
    expect(targets(new Set(), null, ids)).toEqual([]);
    expect(targets(chosen, "gone", ids)).toEqual([]);
  });
});
