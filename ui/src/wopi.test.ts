import { describe, expect, it } from "vitest";
import { applyViews, colourOf, hostMessage, inkOn, othersOf, parseMessage } from "./wopi";

const view = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ ViewId: id, UserId: `u-${name}`, UserName: name, Color: 0x1e90ff, ReadOnly: false, IsCurrentView: false, ...extra });

describe("the online editor's messages", () => {
  it("reads the editor's messages and nothing else", () => {
    expect(parseMessage('{"MessageId":"UI_Share","SendTime":1,"Values":{}}')).toEqual({ id: "UI_Share", values: {} });
    expect(parseMessage({ MessageId: "UI_Close" })).toEqual({ id: "UI_Close", values: null });
    for (const junk of ["not json", "{}", '{"MessageId":3}', null, 42, { type: "webpackOk" }]) expect(parseMessage(junk)).toBeNull();
    const sent = JSON.parse(hostMessage("Get_Views"));
    expect([sent.MessageId, sent.Values, typeof sent.SendTime]).toEqual(["Get_Views", {}, "number"]);
  });

  it("follows who joins and leaves, and shows each other person once", () => {
    let views = applyViews(null, { id: "Get_Views_Resp", values: [view(0, "Ana", { IsCurrentView: true }), view(1, "Raj")] });
    views = applyViews(views, { id: "View_Added", values: view(2, "Mei", { ReadOnly: "true", Color: 0xffd700 }) });
    views = applyViews(views, { id: "View_Added", values: view(3, "Raj") });
    views = applyViews(views, { id: "View_Added", values: view(4, "Ana") });
    expect(othersOf(views!).map((v) => [v.name, v.readOnly, v.color])).toEqual([
      ["Raj", false, "#1e90ff"],
      ["Mei", true, "#ffd700"],
    ]);
    views = applyViews(views, { id: "View_Removed", values: { ViewId: 1 } });
    expect(othersOf(views!).map((v) => v.name)).toEqual(["Mei", "Raj"]);
    expect(applyViews(views, { id: "View_Added", values: { UserName: "no id" } })).toBe(views);
    expect(applyViews(views, { id: "Get_Views_Resp", values: "nonsense" })).toBe(views);
    // Joining again keeps knowing which view is this person's own.
    views = applyViews(views, { id: "View_Added", values: view(0, "Ana") });
    expect(othersOf(views!).map((v) => v.name)).toEqual(["Mei", "Raj"]);
  });

  it("reads Collabora 26's list of views, sent at every change", () => {
    // As Collabora CODE 26.04 sends them: ids and flags as strings, colours as numbers or "#rrggbb".
    const list = [
      { ViewId: "4", UserName: "Administrator", UserId: "u-admin", Color: 411298, ReadOnly: "0", IsCurrentView: true },
      { ViewId: "5", UserName: "Ana Silva", UserId: "u-ana", Color: "#b4371e", ReadOnly: "1", IsCurrentView: false },
    ];
    const views = applyViews(null, { id: "Views_List", values: list })!;
    expect(othersOf(views).map((v) => [v.id, v.name, v.readOnly, v.color])).toEqual([[5, "Ana Silva", true, "#b4371e"]]);
    expect(views.find((v) => v.current)?.color).toBe("#0646a2");
    expect(othersOf(applyViews(views, { id: "Views_List", values: list.slice(0, 1) })!)).toEqual([]);
  });

  it("waits for the list before following joins", () => {
    expect(applyViews(null, { id: "View_Added", values: view(0, "Ana") })).toBeNull();
    expect(applyViews(null, { id: "View_Removed", values: { ViewId: 0 } })).toBeNull();
    expect(applyViews(null, { id: "Get_Views_Resp", values: [] })).toEqual([]);
  });

  it("gives every colour a readable name tag", () => {
    expect([colourOf(0x00ff00), colourOf("16711680"), colourOf("#1E90FF"), colourOf("red"), colourOf(undefined)]).toEqual(["#00ff00", "#ff0000", "#1e90ff", "#64748b", "#64748b"]);
    expect([inkOn("#ffd700"), inkOn("#1d4ed8"), inkOn("#000000")]).toEqual(["#111827", "#ffffff", "#ffffff"]);
  });
});
