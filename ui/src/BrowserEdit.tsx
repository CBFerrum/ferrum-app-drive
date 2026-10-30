// A Drive file in a browser editor (Ferrum docs/plan/browser-editors.md): an editor an add-on
// offers on `drive.editor`, served by the operator's editor server and framed through its relay.
// The page downloads the file and hands it over; each save the editor sends back becomes a new
// version, under the session's editor lock and from the version the page opened. Read-only
// sessions, and saves under another name (Save As, an export, a file the person opened inside
// the editor), make new files instead; conflicts ask first.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, bootstrap, download, errorMessage, fetchBlob, request } from "@ferrum/client";
import { Alert, Badge, Button, Dialog, EmptyState, Spinner, confirmDialog, toast } from "@ferrum/kit";
import { editable, useEditors } from "./Drive";
import { presenceLabel, usePresence } from "./presence";

interface Session {
  kind: "browser";
  url: string;
  name: string;
  folder: string | null;
  size: number;
  version: number;
  action: "edit" | "view";
  lock: string | null;
  lock_seconds: number;
  held_by: string | null;
  held_in: "browser" | "online" | "checkout" | null;
  author: string;
}

type Status = "starting" | "ready" | "saving" | "saved" | "unsaved";

/** How long the editor may take to start before the page gives up (the relay waits 30 s). */
const START_MS = 45_000;

const FAILURES: Record<string, string> = {
  unknown: "This editor is not on the editor server. Ask your administrator to update it.",
  missing: "This editor is not on the editor server. Ask your administrator to update it.",
  timeout: "The editor did not start in time. It needs a recent browser with WebGL.",
};

/** `report.xlsx` → `report (copy).xlsx`; Drive adds a number if that name is taken. */
export function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (copy)${name.slice(dot)}` : `${name} (copy)`;
}

/** Why a session opened read-only, for people. */
export function readOnlyReason(s: Pick<Session, "held_by" | "held_in">, me: string | undefined): string {
  const who = s.held_by && s.held_by === me ? "You are" : `${s.held_by ?? "Someone"} is`;
  switch (s.held_in) {
    case "browser":
      return s.held_by === me ? "You are editing this file in another tab or window." : `${who} editing this file in a browser editor.`;
    case "online":
      return `${who} editing this file in the online editor.`;
    case "checkout":
      return `${s.held_by ?? "Someone"} has checked this file out.`;
    default:
      return "You can view this file but not change it.";
  }
}

/** `/drive/edit/:file/:editor`. */
export function BrowserEditPage() {
  const { file = "", editor: editorId } = useParams();
  const navigate = useNavigate();
  const editors = useEditors();
  const editor = editors.browser.find((e) => e.id === editorId);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [dirty, setDirty] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ name: string; bytes: ArrayBuffer; message: string } | null>(null);
  const [unsaved, setUnsaved] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // This page's own key: launching again (React mounts twice in development) gets its lock back,
  // while another tab of the same person opens read-only.
  const pageKey = useRef(Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const port = useRef<MessagePort | null>(null);
  // What the port's handler needs, current at every message.
  const live = useRef({ session, lost, base: 0, version: "" });
  live.current.session = session;
  live.current.lost = lost;
  const me = bootstrap()?.person?.email;
  const others = usePresence(session ? file : undefined, session ? (session.action === "edit" && !lost ? "edit" : "view") : null);

  // The session: who may edit, and the editor lock.
  useEffect(() => {
    if (!editor) return;
    let alive = true;
    request<Session>(`/api/app/drive/editor/${file}`, { method: "POST", query: { kind: "browser", session: pageKey.current } }).then(
      (s) => {
        if (!alive) return;
        if (editor.max_mb && s.size > editor.max_mb * 1024 * 1024) {
          setError(`${s.name} is larger than ${editor.max_mb} MB, the most ${editor.title} opens.`);
          return;
        }
        live.current.base = s.version;
        setSession(s);
      },
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file and editor
  }, [file, editor?.id]);

  // Keep the lock while the editor is open; give it back when leaving.
  const lock = session?.action === "edit" && !lost ? session.lock : null;
  useEffect(() => {
    if (!lock || !session) return;
    const lockPath = (op: string) => `/api/app/drive/editor/${file}/lock?${new URLSearchParams({ lock, op })}`;
    const every = Math.max(60, Math.floor(session.lock_seconds / 3)) * 1000;
    const timer = setInterval(() => {
      request(lockPath("refresh"), { method: "POST" }).catch((e: unknown) => {
        if (e instanceof ApiError && [403, 404, 409].includes(e.status)) setLost(errorMessage(e));
      });
    }, every);
    const release = () => {
      void fetch(lockPath("release"), { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {});
    };
    addEventListener("pagehide", release);
    return () => {
      clearInterval(timer);
      removeEventListener("pagehide", release);
      release();
    };
  }, [lock, file, session]);

  // Changes not yet in Drive: the browser asks before leaving.
  const unsafe = dirty || !!unsaved || !!conflict;
  useEffect(() => {
    if (!unsafe) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [unsafe]);

  // The editor must say it started.
  useEffect(() => {
    if (!session || status !== "starting" || failure) return;
    const timer = setTimeout(() => setFailure("The editor server did not answer."), START_MS);
    return () => clearTimeout(timer);
  }, [session, status, failure]);

  const saveCopy = async (name: string, bytes: ArrayBuffer) => {
    const s = live.current.session!;
    const put = (folder: string | null) =>
      request<{ name: string }>("/api/app/drive/upload", { method: "POST", query: { folder: folder ?? undefined, name, on_conflict: "keep_both" }, body: new Blob([bytes]) });
    try {
      return await put(s.folder);
    } catch (e) {
      // No right to add to the file's folder: into the person's own files.
      if (s.folder && e instanceof ApiError && [403, 404].includes(e.status)) return put(null);
      throw e;
    }
  };

  /** A save from the editor: a new version, or with `how`, a replacement regardless of changes
   *  made meanwhile or a copy beside the file. */
  const save = async (name: string, bytes: ArrayBuffer, how?: "replace" | "copy") => {
    const { session: s, lost: gone, base, version } = live.current;
    if (!s || !editor) return;
    setStatus("saving");
    setConflict(null);
    try {
      // Only the opened file's own name is a new version of it; editors that offer Open and New
      // inside them can hand back other files too.
      if (name.toLowerCase() !== s.name.toLowerCase()) {
        const made = await saveCopy(name, bytes);
        toast(`Saved ${made.name} next to ${s.name}`);
      } else if (how !== "copy" && s.action === "edit" && s.lock && !gone) {
        const comment = `Saved in ${editor.title}${version ? ` ${version}` : ""}`;
        const saved = await request<{ version: number }>(`/api/app/drive/files/${file}/versions`, {
          method: "POST",
          query: { lock: s.lock, base: how === "replace" ? undefined : base, comment },
          body: new Blob([bytes]),
        });
        live.current.base = saved.version;
      } else {
        const made = await saveCopy(copyName(s.name), bytes);
        toast(`Saved a copy: ${made.name}`);
      }
      setUnsaved(null);
      setStatus("saved");
    } catch (e) {
      setStatus("unsaved");
      if (e instanceof ApiError && e.status === 409) setConflict({ name, bytes, message: errorMessage(e) });
      else {
        setUnsaved({ name, bytes });
        toast(`Not saved: ${errorMessage(e)}`, "error");
      }
    }
  };

  const onMessage = (m: unknown) => {
    const d = (m ?? {}) as { type?: string; version?: string; dirty?: boolean; name?: string; bytes?: unknown; error?: string };
    if (d.type === "ready") {
      live.current.version = String(d.version ?? "");
      setStatus("ready");
    } else if (d.type === "dirty") setDirty(!!d.dirty);
    else if (d.type === "save" && d.bytes instanceof ArrayBuffer) void save(String(d.name ?? live.current.session?.name ?? "file"), d.bytes);
    else if (d.type === "failed") setFailure(FAILURES[String(d.error)] ?? `The editor could not start: ${d.error}`);
  };

  // The relay loaded: connect, and send the file along (the relay keeps it until the editor is ready).
  const connect = () => {
    const s = live.current.session;
    const w = frame.current?.contentWindow;
    if (!s || !w || port.current) return;
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = (e) => onMessage(e.data);
    w.postMessage({ type: "connect", author: s.author }, new URL(s.url).origin, [channel.port2]);
    fetchBlob(`/api/app/drive/files/${file}/content`)
      .then((b) => b.arrayBuffer())
      .then(
        (bytes) => channel.port1.postMessage({ type: "open", name: s.name, bytes }, [bytes]),
        (e: unknown) => setFailure(`The file could not be read: ${errorMessage(e)}`),
      );
  };

  const takeOver = async () => {
    try {
      const s = await request<Session>(`/api/app/drive/editor/${file}`, { method: "POST", query: { kind: "browser", take_over: "true", session: pageKey.current } });
      if (s.action !== "edit") {
        toast(readOnlyReason(s, me), "error");
        return;
      }
      // The editor keeps what it has open; saves still start from the version it opened.
      setLost(null);
      setSession((old) => (old ? { ...old, action: "edit", lock: s.lock, held_by: null, held_in: null } : s));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const leave = async () => {
    if (unsafe && !(await confirmDialog({ title: "Leave without saving?", message: "Changes not saved to Drive will be lost.", confirmLabel: "Leave", danger: true }))) return;
    navigate(-1);
  };

  if (!editors.loading && !editor) {
    return (
      <EmptyState title="This editor is not available" icon="file">
        <p className="muted">Its add-on is not installed in this workspace, or the editor server is not set up.</p>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </EmptyState>
    );
  }
  if (error || failure) {
    return (
      <EmptyState title={error ? "This file cannot be opened here" : "The editor could not start"} icon="file">
        <p className="muted">{error ?? failure}</p>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          <Button onClick={() => navigate(-1)}>Back</Button>
          {session && (
            <Button icon="download" onClick={() => void download(`/api/app/drive/files/${file}/content`, session.name).catch((e) => toast(errorMessage(e), "error"))}>
              Download
            </Button>
          )}
        </div>
      </EmptyState>
    );
  }
  if (!session || !editor) return <Spinner label="Opening the editor" />;

  const editing = session.action === "edit" && !lost;
  return (
    <div className="editor-page">
      <div className="editor-bar">
        <Button size="sm" icon="left" onClick={() => void leave()}>
          Back
        </Button>
        <strong>{session.name}</strong>
        {!editing && <Badge>Read only</Badge>}
        {others.length > 0 && <Badge tone="green">{presenceLabel(others)}</Badge>}
        {status === "starting" && <Badge>Starting</Badge>}
        {status === "saving" && <Badge tone="blue">Saving</Badge>}
        {status === "unsaved" && <Badge tone="red">Not saved</Badge>}
        {status !== "saving" && status !== "unsaved" && dirty && <Badge tone="amber">Unsaved changes</Badge>}
        {status === "saved" && !dirty && <Badge tone="green">Saved</Badge>}
        <span className="faint">{editing ? "Ctrl+S or ⌘S saves a new version in Drive." : "Ctrl+S or ⌘S saves a copy in Drive."}</span>
        {unsaved && (
          <Button size="sm" onClick={() => void save(unsaved.name, unsaved.bytes)}>
            Try again
          </Button>
        )}
      </div>
      {session.action === "view" && (
        <Alert
          tone="info"
          action={
            session.held_in === "browser" && session.held_by === me ? (
              <Button size="sm" onClick={() => void takeOver()}>
                Edit here instead
              </Button>
            ) : session.held_in === "browser" && editors.online && editable(session.name) ? (
              // Browser editors are one person's at a time: others may read it in the online editor.
              <Link className="btn btn-default btn-sm" to={`/drive/edit/${file}`}>
                Open in the online editor (read only)
              </Link>
            ) : undefined
          }
        >
          {readOnlyReason(session, me)}
        </Alert>
      )}
      {lost && <Alert tone="warning">Your editing session ended: {lost} Saving now makes a copy.</Alert>}
      <iframe
        ref={frame}
        src={`${session.url}?${new URLSearchParams({ program: editor.program })}`}
        title={`${session.name} in ${editor.title}`}
        className="editor-frame"
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={connect}
      />
      {conflict && (
        <Dialog
          open
          title="Not saved"
          onClose={() => setConflict(null)}
          footer={
            <>
              <Button onClick={() => setConflict(null)}>Cancel</Button>
              {editing && conflict.message.includes("changed since it was opened") && (
                <Button onClick={() => void save(conflict.name, conflict.bytes, "replace")}>Replace</Button>
              )}
              <Button variant="primary" onClick={() => void save(conflict.name, conflict.bytes, "copy")}>
                Save a copy
              </Button>
            </>
          }
        >
          <p>{conflict.message}</p>
          <p className="muted">A copy keeps your changes beside the file. Replacing keeps the other changes in the file's history.</p>
        </Dialog>
      )}
    </div>
  );
}
