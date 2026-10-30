// The online editor's messages (the WOPI PostMessage API, with Collabora's additions; Ferrum
// docs/plan/collaboration.md, C2): who is in the document, its buttons for sharing, version
// history and closing (Drive's own panels answer them), and whether it has unsaved changes.
// Messages are JSON strings: `{"MessageId", "SendTime", "Values"}`.

export interface EditorView {
  id: number;
  userId: string;
  name: string;
  color: string;
  readOnly: boolean;
  current: boolean;
}

export interface EditorMessage {
  id: string;
  values: unknown;
}

/** A message the editor posted, or null for anything else. */
export function parseMessage(data: unknown): EditorMessage | null {
  let v = data;
  if (typeof data === "string") {
    try {
      v = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  return typeof m.MessageId === "string" ? { id: m.MessageId, values: m.Values ?? null } : null;
}

/** A message for the editor. */
export function hostMessage(id: string, values: Record<string, unknown> = {}): string {
  return JSON.stringify({ MessageId: id, SendTime: Date.now(), Values: values });
}

/** Collabora's colours: 0xRRGGBB numbers (in the list of views) or "#rrggbb" (as people join). */
export function colourOf(c: unknown): string {
  if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  const n = typeof c === "string" && /^\d+$/.test(c) ? Number(c) : c;
  return typeof n === "number" && Number.isFinite(n) ? `#${(n & 0xffffff).toString(16).padStart(6, "0")}` : "#64748b";
}

/** Black or white, whichever reads better on `hex`. */
export function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#111827" : "#ffffff";
}

// Collabora sends flags as booleans or strings: "true", "1", "0".
const yes = (v: unknown) => v === true || v === "true" || v === "1" || v === 1;

function viewOf(v: unknown): EditorView | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = Number(r.ViewId);
  if (r.ViewId === undefined || r.ViewId === null || !Number.isFinite(id)) return null;
  const name = typeof r.UserName === "string" && r.UserName.trim() ? r.UserName.trim() : "Someone";
  return { id, userId: String(r.UserId ?? name), name, color: colourOf(r.Color), readOnly: yes(r.ReadOnly), current: yes(r.IsCurrentView) };
}

/**
 * The views after a message: `Get_Views_Resp` lists them (null until it does), and so does
 * `Views_List`, which newer Collabora sends at every change. `View_Added` and `View_Removed` (older
 * ones) change the list. Only a list says which view is this person's own.
 */
export function applyViews(views: EditorView[] | null, m: EditorMessage): EditorView[] | null {
  switch (m.id) {
    case "Get_Views_Resp":
    case "Views_List":
      return Array.isArray(m.values) ? m.values.map(viewOf).filter((v): v is EditorView => !!v) : views;
    case "View_Added": {
      const v = viewOf(m.values);
      if (!views || !v) return views;
      const was = views.find((x) => x.id === v.id);
      return [...views.filter((x) => x.id !== v.id), { ...v, current: v.current || !!was?.current }];
    }
    case "View_Removed": {
      const id = Number((m.values as Record<string, unknown> | null)?.ViewId);
      return views && views.filter((x) => x.id !== id);
    }
    default:
      return views;
  }
}

/** Everyone else in the document, once per person (whoever has it open in two tabs). */
export function othersOf(views: EditorView[]): EditorView[] {
  const me = new Set(views.filter((v) => v.current).map((v) => v.userId));
  const seen = new Set<string>();
  return views.filter((v) => !v.current && !me.has(v.userId) && !seen.has(v.userId) && !!seen.add(v.userId));
}
