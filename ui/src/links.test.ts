import { describe, expect, it } from "vitest";
import { type LinkDraft, type LinkPolicy, OPEN_POLICY, blankDraft, departure, latestEnd, linkBody, makePassword, problems, rules, stateOf } from "./linkPolicy";

const today = "2026-11-10";
const draft = (extra: Partial<LinkDraft> = {}): LinkDraft => ({ access: "View", expires: "", password: "", limit: "", note: "", answerable: "", ...extra });
const strict: LinkPolicy = { allow_public_links: true, max_link_days: 7, link_password_required: true };

describe("public links and the workspace's rules", () => {
  it("lets a link end on the last day the rules allow, counted as the server counts it", () => {
    expect(latestEnd(OPEN_POLICY, today)).toBeNull();
    // A day means its end: seven days from this afternoon reach the end of the sixth day on.
    expect(latestEnd(strict, today)).toBe("2026-11-16");
    expect(latestEnd({ ...strict, max_link_days: 1 }, today)).toBe(today);
  });

  it("starts a form on the longest the rules allow, else with no end", () => {
    expect(blankDraft(OPEN_POLICY, today)).toEqual(draft());
    expect(blankDraft(strict, today)).toEqual(draft({ expires: "2026-11-16" }));
  });

  it("tells the rules before a link is refused", () => {
    expect(rules(OPEN_POLICY)).toBeNull();
    expect(rules(strict)).toBe("Links in this workspace need a password and end within 7 days.");
    expect(rules({ ...OPEN_POLICY, link_password_required: true })).toBe("Links in this workspace need a password.");
    expect(rules({ ...OPEN_POLICY, max_link_days: 1 })).toBe("Links in this workspace end within a day.");
    expect(rules({ ...OPEN_POLICY, allow_public_links: false })).toBeNull();
  });

  it("finds what the server would refuse, field by field", () => {
    expect(problems(draft(), OPEN_POLICY, today)).toEqual({});
    expect(problems(draft(), strict, today)).toEqual({ expires: "Pick the day the link ends", password: "This workspace needs a password on links" });
    expect(problems(draft({ expires: "2026-11-17", password: "long enough" }), strict, today)).toEqual({ expires: "The latest is 2026-11-16" });
    expect(problems(draft({ expires: "2026-11-16", password: "long enough" }), strict, today)).toEqual({});
    expect(problems(draft({ expires: "2026-11-09" }), OPEN_POLICY, today).expires).toBe("Pick a day that has not passed");
    expect(problems(draft({ expires: today }), OPEN_POLICY, today)).toEqual({});
    expect(problems(draft({ password: "short" }), OPEN_POLICY, today).password).toBe("Use 8 to 256 characters");
    expect(problems(draft({ limit: "0" }), OPEN_POLICY, today).limit).toBeDefined();
    expect(problems(draft({ limit: "2.5" }), OPEN_POLICY, today).limit).toBeDefined();
    expect(problems(draft({ limit: "25" }), OPEN_POLICY, today)).toEqual({});
    expect(problems(draft({ note: "x".repeat(281) }), OPEN_POLICY, today).note).toBe("At most 280 characters");
    expect(problems(draft({ answerable: "alice" }), OPEN_POLICY, today).answerable).toBe("Pick someone of this workspace");
    expect(problems(draft({ answerable: " alice@acme.test " }), OPEN_POLICY, today)).toEqual({});
  });

  it("makes the parameters of create_link, leaving out what is empty", () => {
    expect(linkBody("i1", draft())).toEqual({ item: "i1", access: "View" });
    expect(linkBody("i1", draft({ access: "Download", expires: "2026-12-01", password: "open sesame", limit: " 5 ", note: "  For the audit  " }))).toEqual({
      item: "i1",
      access: "Download",
      expires_at: "2026-12-01",
      password: "open sesame",
      max_downloads: 5,
      note: "For the audit",
    });
    expect(linkBody("i1", draft({ answerable: " alice@acme.test " }))).toEqual({ item: "i1", access: "View", answerable: "alice@acme.test" });
  });

  it("says what became of a link when someone left", () => {
    const link = { id: "l", access: "View", has_password: false };
    const name = (email: string) => (email === "pat@acme.test" ? "Pat" : email);
    expect(departure(link, name)).toBeNull();
    expect(departure({ ...link, left_by: "pat@acme.test", on_leaving: "Stayed" }, name)).toBe("Stayed when Pat left: it is the workspace's");
    expect(departure({ ...link, left_by: "pat@acme.test", on_leaving: "Passed On" }, name)).toBe("Passed on when Pat left");
    expect(departure({ ...link, left_by: "bo@acme.test", on_leaving: "Stopped" }, name)).toBe("Stopped when bo@acme.test left: nobody took over");
    expect(departure({ ...link, left_by: "pat@acme.test", on_leaving: "Kept" }, name)).toBe("Kept when Pat left, as the workspace keeps such links");
  });

  it("says how a link stands", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const link = { id: "l", access: "View", has_password: false };
    expect(stateOf(link, now)).toBe("active");
    expect(stateOf({ ...link, revoked: true }, now)).toBe("off");
    expect(stateOf({ ...link, expires_at: "2026-11-10T11:59:00Z" }, now)).toBe("ended");
    expect(stateOf({ ...link, expires_at: "2026-11-11T00:00:00Z" }, now)).toBe("active");
    expect(stateOf({ ...link, max_downloads: 3, download_count: 3 }, now)).toBe("used up");
    expect(stateOf({ ...link, max_downloads: 3, download_count: 2 }, now)).toBe("active");
    expect(stateOf({ ...link, max_downloads: 0, download_count: 9 }, now)).toBe("active");
  });

  it("makes a password that is easy to read out", () => {
    const pw = makePassword((n) => Array.from({ length: n }, (_, i) => i * 7919));
    expect(pw).toHaveLength(14);
    expect(pw).toMatch(/^[a-hj-km-np-zA-HJ-KM-NP-Z2-9]+$/);
    expect(makePassword((n) => Array.from({ length: n }, () => 0), 8)).toHaveLength(8);
  });
});
