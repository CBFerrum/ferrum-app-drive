import { describe, expect, it } from "vitest";
import { fullness, gigabytesOf, leftLabel, megabytesOf, spaceLabel, toneOf } from "./usage";

const GB = 1024 ** 3;

describe("how much space is used", () => {
  it("measures how full, and says nothing where nothing limits", () => {
    expect(fullness({ used: GB, quota: 4 * GB })).toBe(0.25);
    expect(fullness({ used: 5 * GB, quota: 4 * GB })).toBe(1);
    expect(fullness({ used: GB, quota: null })).toBeNull();
    expect(fullness({ used: GB, quota: 0 })).toBeNull();
  });

  it("turns amber near the limit and red at it", () => {
    expect(toneOf({ used: 0.5 * GB, quota: GB })).toBe("ok");
    expect(toneOf({ used: 0.8 * GB, quota: GB })).toBe("near");
    expect(toneOf({ used: 0.99 * GB, quota: GB })).toBe("near");
    expect(toneOf({ used: GB, quota: GB })).toBe("full");
    expect(toneOf({ used: 9 * GB, quota: null })).toBe("ok");
  });

  it("reads in words", () => {
    expect(spaceLabel({ used: 1.2 * GB, quota: 5 * GB })).toBe("1.2 GB of 5.0 GB");
    expect(spaceLabel({ used: 3 * 1024, quota: null })).toBe("3.0 KB used");
    expect(leftLabel({ used: 4 * GB, quota: 5 * GB })).toBe("1.0 GB left");
    expect(leftLabel({ used: 6 * GB, quota: 5 * GB })).toBe("No space left");
    expect(leftLabel({ used: GB, quota: null })).toBeNull();
  });

  it("turns the gigabytes a person types into the megabytes the server takes, and back", () => {
    expect(megabytesOf("50")).toBe(51200);
    expect(megabytesOf("0.5")).toBe(512);
    expect(megabytesOf("1,5")).toBe(1536);
    expect(megabytesOf("")).toBe(0);
    expect(megabytesOf("lots")).toBeNull();
    expect(megabytesOf("-2")).toBeNull();
    expect(gigabytesOf(50 * GB)).toBe("50");
    expect(gigabytesOf(0.5 * GB)).toBe("0.5");
    expect(gigabytesOf(null)).toBe("");
  });
});
