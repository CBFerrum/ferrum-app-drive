import { describe, expect, it } from "vitest";
import { addresses, groupShares, shareFor } from "./access";

const share = (id: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@acme.test`, permission: "View", ...extra });

describe("who can open an item", () => {
  it("tells what was given to it from what comes down from the folders above, the nearest first", () => {
    const path = [
      { id: "top", name: "Projects" },
      { id: "mid", name: "Q3" },
    ];
    const { direct, inherited } = groupShares([share("a"), share("b", { inherited_from: "top" }), share("c", { inherited_from: "mid" }), share("d", { inherited_from: "top" })], path);
    expect(direct.map((s) => s.id)).toEqual(["a"]);
    expect(inherited.map((g) => [g.name, g.shares.map((s) => s.id)])).toEqual([
      ["Q3", ["c"]],
      ["Projects", ["b", "d"]],
    ]);
  });

  it("does not name a folder it cannot see", () => {
    expect(groupShares([share("a", { inherited_from: "hidden" })], []).inherited[0].name).toBe("a folder above");
  });

  it("says who a share is for", () => {
    expect(shareFor({ email: "ana@acme.test" })).toBe("ana@acme.test");
    expect(shareFor({ role: "Accountants" })).toBe("Everyone with the role Accountants");
    expect(shareFor({})).toBe("Someone");
  });

  it("takes addresses out of pasted text, once each", () => {
    expect(addresses("Ana@Acme.test, ben@acme.test; <cy@acme.test>\nana@acme.test  nobody")).toEqual({
      emails: ["ana@acme.test", "ben@acme.test", "cy@acme.test"],
      rest: ["nobody"],
    });
    expect(addresses("")).toEqual({ emails: [], rest: [] });
  });
});
