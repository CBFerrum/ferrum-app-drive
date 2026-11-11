// A file shown in place, over Drive's list (`?preview=<file>`): previous and next through the folder
// with the arrow keys, Escape to close, and a header with its name, Download, Share, its editor and
// its details. Every kind of file has an answer: images (fit, zoom, turn), video and audio in the
// browser's own players, PDFs drawn in the page, text, Markdown, tables, JSON and code, Ferrum
// documents, and for anything else (or an office file with no office editor) a state that says so
// and offers the download. Loaded when the first file is opened.

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Info, Maximize2, Minus, Plus, RotateCcw, RotateCw, Share2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Markdown, ReaderSkeleton, Spinner, StatePanel, type StateKind } from "@ferrum/kit";
import { Button as UiButton } from "@ferrum/kit/primitives";
import { CSV_ROWS, TEXT_MAX, kindLabel, previewKind } from "./kinds";
import { parseCsv } from "./csv";
import { splitTables } from "./markdownTables";
import { type Editors } from "./FileList";
import { FileGlyph } from "./FileGlyph";
import { EditorLink } from "./editors";
import { type Item, type ItemInfo, TO_DOC, allows, contentUrl, defaultEditor, editorsFor, shownName, sizeLabel } from "./files";

const PdfView = lazy(() => import("./PdfView"));

/** A failed fetch as a state: refused, no connection, or broken. */
function kindOf(status: number): StateKind {
  return status === 403 || status === 401 ? "denied" : status === 0 ? "offline" : "failed";
}
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const problem = (e: unknown) => (e instanceof Refused ? e : new Refused(e instanceof TypeError ? 0 : 500, errorMessage(e)));

/** What a file's bytes say, read up to `max` of them (the rest of a long one is not fetched). */
function useText(url: string, max: number) {
  const [state, set] = useState<{ text: string; truncated: boolean } | Refused | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    set(null);
    void (async () => {
      try {
        const r = await fetch(url, { signal: stop.signal, credentials: "same-origin" });
        if (!r.ok) throw new Refused(r.status, r.status === 403 ? tr("You no longer have access to this file.") : tr("The server answered {status}.", { status: r.status }));
        const reader = r.body?.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        let more = false;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (got >= max) {
            more = true;
            void reader.cancel();
            break;
          }
        }
        const all = new Uint8Array(Math.min(got, max));
        let at = 0;
        for (const c of chunks) {
          const part = c.subarray(0, Math.max(0, Math.min(c.length, all.length - at)));
          all.set(part, at);
          at += part.length;
        }
        // A cut inside a multi-byte character leaves one wrong mark at the end; the "shown in part" note covers it.
        set({ text: new TextDecoder("utf-8").decode(all), truncated: more });
      } catch (e) {
        if (!stop.signal.aborted) set(problem(e));
      }
    })();
    return () => stop.abort();
  }, [url, max, tries]);
  return { state, retry: () => setTries((n) => n + 1) };
}

function Failed({ error, onRetry }: { error: Refused; onRetry?: () => void }) {
  return <StatePanel kind={kindOf(error.status)} title={error.status === 403 ? tr("You cannot open this file") : tr("This file cannot be shown")} error={error.status === 403 ? undefined : error} onRetry={error.status === 403 ? undefined : onRetry} />;
}

// ───────────────────────────── the kinds ─────────────────────────────

/** Whether a key press happens in something that wants its keys for itself (the dialog the preview is in does not count). */
const inField = (target: EventTarget | null) => !!(target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true']");

const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/** An image: fitted to the screen, zoomed in steps (scrolling when larger), turned in quarters. Turning is of the view only. */
function ImageView({ item, url, down }: { item: Pick<Item, "name">; url: string; down: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [room, setRoom] = useState<[number, number]>([0, 0]);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [turn, setTurn] = useState(0);
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(/\.svg$/i.test(item.name) ? null : url);
  // A picture made of markup is drawn from bytes typed as an image, so nothing in it can run.
  useEffect(() => {
    if (!/\.svg$/i.test(item.name)) return;
    let made = "";
    void fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => setSrc((made = URL.createObjectURL(new Blob([b], { type: "image/svg+xml" })))))
      .catch(() => setFailed(true));
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, item.name]);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setRoom([el.clientWidth, el.clientHeight]));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const sideways = turn % 180 !== 0;
  const [w, h] = natural ? (sideways ? [natural[1], natural[0]] : natural) : [1, 1];
  const fit = Math.min(1, room[0] / w, room[1] / h) || 1;
  const scale = zoom === "fit" ? fit : zoom;
  const step = (dir: 1 | -1) => {
    const now = scale;
    const next = dir > 0 ? STEPS.find((s) => s > now + 0.001) : [...STEPS].reverse().find((s) => s < now - 0.001);
    if (next) setZoom(next);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || inField(e.composedPath()[0] ?? e.target)) return;
      if (e.key === "+" || e.key === "=") step(1);
      else if (e.key === "-") step(-1);
      else if (e.key === "0") setZoom("fit");
      else if (e.key === "r") setTurn((t) => (t + (e.shiftKey ? 270 : 90)) % 360);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  });
  if (failed) return <StatePanel kind="failed" title={tr("This image cannot be shown")} action={<UiButton onClick={down}>{tr("Download")}</UiButton>}>{tr("The browser could not draw it. It may be damaged, or in a format browsers do not show.")}</StatePanel>;
  return (
    <div className="drive-image">
      <div ref={stage} className="drive-image-stage" data-zoomed={zoom !== "fit" || undefined}>
        {!natural && <Spinner label={tr("Loading the picture")} />}
        <div className="drive-image-box" style={{ inlineSize: natural ? w * scale : undefined, blockSize: natural ? h * scale : undefined }}>
          {src && (
            <img
              src={src}
              alt={item.name}
              draggable={false}
              style={natural ? { inlineSize: natural[0] * scale, blockSize: natural[1] * scale, transform: `rotate(${turn}deg)` } : { visibility: "hidden" }}
              onLoad={(e) => setNatural([e.currentTarget.naturalWidth || 1, e.currentTarget.naturalHeight || 1])}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </div>
      <div className="drive-image-bar" role="toolbar" aria-label={tr("Picture controls")}>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Zoom out")} onClick={() => step(-1)}>
          <Minus />
        </UiButton>
        <button type="button" className="drive-pdf-zoom" aria-label={tr("Fit to screen")} title={tr("Fit to screen")} onClick={() => setZoom("fit")}>
          {Math.round(scale * 100)}%
        </button>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Zoom in")} onClick={() => step(1)}>
          <Plus />
        </UiButton>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Fit to screen")} onClick={() => setZoom("fit")}>
          <Maximize2 />
        </UiButton>
        <span className="drive-pdf-sep" aria-hidden="true" />
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Turn left")} onClick={() => setTurn((t) => (t + 270) % 360)}>
          <RotateCcw />
        </UiButton>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Turn right")} onClick={() => setTurn((t) => (t + 90) % 360)}>
          <RotateCw />
        </UiButton>
      </div>
    </div>
  );
}

/** Video and audio in the browser's own player (it asks the server for the parts it plays, and seeks). */
function MediaView({ item, url, video, down }: { item: Pick<Item, "name">; url: string; video: boolean; down: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <StatePanel kind="failed" title={video ? tr("This video cannot be played here") : tr("This sound cannot be played here")} action={<UiButton onClick={down}>{tr("Download")}</UiButton>}>
        {tr("Your browser does not play this format. Download it to play it in another program.")}
      </StatePanel>
    );
  return video ? (
    <div className="drive-media">
      <video className="drive-video" src={url} controls preload="metadata" playsInline aria-label={item.name} onError={() => setFailed(true)} />
    </div>
  ) : (
    <div className="drive-media drive-audio">
      <FileGlyph kind="file" name={item.name} size={72} />
      <strong>{isolate(item.name)}</strong>
      <audio src={url} controls preload="metadata" aria-label={item.name} onError={() => setFailed(true)} />
    </div>
  );
}

/** Text, code and JSON: monospace, wrapped or in one line each. */
function TextView({ url, kind }: { url: string; kind: "text" | "code" | "json" }) {
  const { state, retry } = useText(url, TEXT_MAX);
  const [wrap, setWrap] = useState(true);
  const shown = useMemo(() => {
    if (!state || state instanceof Refused) return null;
    if (kind === "json" && !state.truncated) {
      try {
        return { text: JSON.stringify(JSON.parse(state.text), null, 2), note: null as string | null };
      } catch {
        return { text: state.text, note: tr("This is not valid JSON, so it is shown as it is.") };
      }
    }
    return { text: state.text, note: null };
  }, [state, kind]);
  if (!state) return <ReaderSkeleton />;
  if (state instanceof Refused) return <Failed error={state} onRetry={retry} />;
  if (!state.text) return <StatePanel kind="empty" title={tr("This file is empty")} />;
  return (
    <div className="drive-text">
      <div className="drive-text-bar">
        <label className="drive-text-wrap">
          <input type="checkbox" className="drive-check" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> {tr("Wrap lines")}
        </label>
        {shown?.note && <span className="faint">{isolate(shown.note)}</span>}
        {state.truncated && <span className="faint">{tr("Showing the first {size} of the file.", { size: sizeLabel(TEXT_MAX) })}</span>}
      </div>
      <pre className="drive-pre" data-wrap={wrap || undefined} tabIndex={0} aria-label={tr("File contents")} lang="en" dir="auto">
        {shown?.text}
      </pre>
    </div>
  );
}

/** Markdown drawn as a page, or as written. */
function MarkdownView({ url }: { url: string }) {
  const { state, retry } = useText(url, TEXT_MAX);
  const [raw, setRaw] = useState(false);
  if (!state) return <ReaderSkeleton />;
  if (state instanceof Refused) return <Failed error={state} onRetry={retry} />;
  if (!state.text.trim()) return <StatePanel kind="empty" title={tr("This file is empty")} />;
  return (
    <div className="drive-text">
      <div className="drive-text-bar" role="group" aria-label={tr("How to show it")}>
        <UiButton size="xs" variant={raw ? "outline" : "secondary"} aria-pressed={!raw} onClick={() => setRaw(false)}>
          {tr("Rendered")}
        </UiButton>
        <UiButton size="xs" variant={raw ? "secondary" : "outline"} aria-pressed={raw} onClick={() => setRaw(true)}>
          {tr("Source")}
        </UiButton>
        {state.truncated && <span className="faint">{tr("Showing the first {size} of the file.", { size: sizeLabel(TEXT_MAX) })}</span>}
      </div>
      {raw ? (
        <pre className="drive-pre" data-wrap tabIndex={0} aria-label={tr("File contents")} dir="auto">
          {state.text}
        </pre>
      ) : (
        <div className="drive-prose" dir="auto">
          {splitTables(state.text).map((piece, i) =>
            piece.kind === "text" ? (
              piece.text.trim() ? <Markdown key={i} source={piece.text} /> : null
            ) : (
              <div key={i} className="drive-csv-wrap" tabIndex={0} role="region" aria-label={tr("Table")}>
                <table className="drive-csv">
                  <thead>
                    <tr>
                      {piece.head.map((c, j) => (
                        <th key={j} scope="col" style={{ textAlign: piece.align[j] }}>
                          {isolate(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {piece.rows.map((r, j) => (
                      <tr key={j}>
                        {piece.head.map((_, k) => (
                          <td key={k} style={{ textAlign: piece.align[k] }}>
                            {isolate(r[k] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A table: comma- or tab-separated values, the first rows of it. */
function CsvView({ url }: { url: string }) {
  const { state, retry } = useText(url, TEXT_MAX);
  const table = useMemo(() => (state && !(state instanceof Refused) ? parseCsv(state.text, CSV_ROWS + 1) : null), [state]);
  if (!state) return <ReaderSkeleton />;
  if (state instanceof Refused) return <Failed error={state} onRetry={retry} />;
  if (!table?.rows.length) return <StatePanel kind="empty" title={tr("This file is empty")} />;
  const [head, ...body] = table.rows;
  const rows = body.slice(0, CSV_ROWS);
  const total = table.total - 1;
  return (
    <div className="drive-text">
      <div className="drive-text-bar">
        <span className="faint" role="status">
          {total > CSV_ROWS || state.truncated
            ? tr("Showing the first {shown} rows{value}. Download the file for the rest.", { shown: rows.length.toLocaleString(), value: state.truncated ? "" : tr(" of {total}", { total: total.toLocaleString() }) })
            : total === 1
              ? tr("1 row")
              : tr("{total} rows", { total: total.toLocaleString() })}
        </span>
      </div>
      <div className="drive-csv-wrap" tabIndex={0} role="region" aria-label={tr("Table")}>
        <table className="drive-csv">
          <thead>
            <tr>
              <th scope="col" aria-label={tr("Row")} />
              {head.map((c, i) => (
                <th key={i} scope="col">
                  {isolate(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                {head.map((_, j) => (
                  <td key={j} data-number={/^-?[\d.,]+$/.test(r[j] ?? "") || undefined}>
                    {isolate(r[j] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** An office file in the online editor's read-only view, when this workspace runs one. */
function OnlineView({ id, name }: { id: string; name: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [launch, setLaunch] = useState<{ url: string; access_token: string; access_token_ttl: number } | Refused | null>(null);
  useEffect(() => {
    let live = true;
    api.post<{ url: string; access_token: string; access_token_ttl: number }>(`/api/app/drive/editor/${id}`, undefined, { query: { action: "view" } }).then(
      (l) => live && setLaunch(l),
      (e: unknown) => live && setLaunch(problem(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    if (launch && !(launch instanceof Refused)) form.current?.submit();
  }, [launch]);
  if (launch instanceof Refused) return <Failed error={launch} />;
  const frame = `drive-preview-office-${id}`;
  return (
    <div className="drive-office">
      {!launch && <Spinner label={tr("Opening the file")} />}
      {launch && (
        <form ref={form} action={launch.url} method="post" target={frame} hidden>
          <input type="hidden" name="access_token" value={launch.access_token} />
          <input type="hidden" name="access_token_ttl" value={String(launch.access_token_ttl)} />
        </form>
      )}
      <iframe name={frame} title={tr("{name}, read only", { name })} className="drive-office-frame" allow="fullscreen" />
    </div>
  );
}

/** No office editor on this server: say what is missing and who can fix it; the file can still be downloaded. */
function NoEditor({ down, admin }: { down: () => void; admin: boolean }) {
  return (
    <StatePanel
      kind="empty"
      title={tr("This file needs an office editor to open")}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <UiButton onClick={down}>
            <Download /> {tr("Download")}
          </UiButton>
          {admin && (
            <a className="btn btn-default btn-sm" href="/store/apps/drive/settings">
              {tr("Where editors are turned on")}
            </a>
          )}
        </div>
      }
    >
      {tr("Opening Word, Excel and PowerPoint files needs an office editor, which this workspace's administrator has not turned on.")}
      {admin && <> {tr("As an administrator, you turn one on in the server's configuration (an online editor such as Collabora), or add Drive's browser editors from the Store.")}</>}
    </StatePanel>
  );
}

/** What a file looks like in the preview, by its kind. Also the viewer of Drive's other pages (a link, another app's preview). */
export function FileBody({ id, item, online, admin, down }: { id: string; item: Pick<Item, "name" | "file_type">; online: boolean; admin: boolean; down: () => void }) {
  const url = contentUrl(id);
  const kind = previewKind(item.name, item.file_type);
  switch (kind) {
      case "image":
        return <ImageView item={item} url={`${url}?inline=1`} down={down} />;
      case "video":
      case "audio":
        return <MediaView item={item} url={`${url}?inline=1`} video={kind === "video"} down={down} />;
      case "pdf":
        return (
          <PdfFailable url={`${url}?inline=1`} down={down}>
            {(onFail) => (
              <Suspense fallback={<div className="drive-preview-wait"><Spinner label={tr("Opening the PDF")} /></div>}>
                <PdfView url={`${url}?inline=1`} onFail={onFail} />
              </Suspense>
            )}
          </PdfFailable>
        );
      case "markdown":
        return <MarkdownView url={`${url}?inline=1`} />;
      case "csv":
        return <CsvView url={`${url}?inline=1`} />;
      case "json":
      case "code":
      case "text":
        return <TextView url={`${url}?inline=1`} kind={kind} />;
      case "live":
        // Its page runs nothing (the response is sandboxed), and so is the frame.
        return <iframe className="drive-live" title={item.name} src={`${url}?format=html&inline=1`} sandbox="" />;
      case "office":
        return online ? <OnlineView id={id} name={item.name} /> : <NoEditor down={down} admin={admin} />;
      default:
        return (
          <StatePanel kind="empty" title={tr("No preview for this type")} action={<UiButton onClick={down}><Download /> {tr("Download")}</UiButton>}>
            {tr("Drive cannot show {name} here. Download it to open it in another program.", { name: item.name })}
          </StatePanel>
        );
    }
}

// ───────────────────────────── the overlay ─────────────────────────────

export interface PreviewProps {
  /** The file shown. */
  id: string;
  /** The files of the list it was opened from, in order: the arrow keys go through them. */
  files: Item[];
  editors: Editors;
  narrow: boolean;
  admin: boolean;
  onClose: (lastId: string) => void;
  onGo: (id: string) => void;
  onDownload: (it: Item) => void;
  onShare: (it: Item) => void;
  onDetails: (it: Item) => void;
}

export function Preview({ id, files, editors, narrow, admin, onClose, onGo, onDownload, onShare, onDetails }: PreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState(false);
  const listed = files.find((f) => f.id === id);
  // A file opened from a link, or not in the list: its own details stand in.
  const fetched = useQuery({
    queryKey: ["drive", "item", id],
    queryFn: ({ signal }) => api.get<ItemInfo>("/api/app/drive/item_info", { item: id }, signal),
    staleTime: 0,
  });
  const item: Item | undefined = listed ?? fetched.data;
  const at = files.findIndex((f) => f.id === id);
  const near = (by: number) => (at < 0 ? undefined : files[at + by]);
  const go = useCallback((by: number) => {
    const to = files[at + by];
    if (to) onGo(to.id);
  }, [files, at, onGo]);

  const last = useRef(id);
  last.current = id;
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (!el.open) el.showModal();
    return () => {
      el.close();
      // The page behind it is live again: the focus goes to the file the preview ended on.
      document.querySelector<HTMLElement>(`[data-row="${CSS.escape(last.current)}"]`)?.focus();
    };
  }, []);
  const close = () => onClose(id);
  const rtl = typeof getComputedStyle === "function" && getComputedStyle(document.documentElement).direction === "rtl";
  const keys = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || inField(e.target) || (e.target as Element).closest?.("video, audio")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go((e.key === "ArrowRight") === !rtl ? 1 : -1);
    }
  };

  const name = item ? shownName(item.name) : "";
  const down = () => item && onDownload(item);
  const choices = item ? editorsFor({ id, name: item.name, size: item.size }, editors) : [];
  const open = defaultEditor(choices, narrow);
  const editor = open && open.key !== "view" ? open : undefined;
  const toDoc = choices.find((c) => c.key === TO_DOC);
  const label = !editor ? "" : editor.key === "live" ? tr("Open in Docs") : editor.key === "online" ? (item && allows(item.permission, "Edit") ? tr("Edit online") : tr("Open")) : tr("Open in {label}", { label: editor.label });

  const body = () => {
    if (fetched.error && !listed) return <Failed error={new Refused(Number((fetched.error as { status?: number }).status ?? 500), errorMessage(fetched.error))} onRetry={() => void fetched.refetch()} />;
    if (!item) return <ReaderSkeleton />;
    return <FileBody id={id} item={item} online={editors.online} admin={admin} down={down} />;
  };

  return (
    <dialog ref={dialog} className="drive-preview" aria-label={name || tr("Preview")} onCancel={(e) => (e.preventDefault(), close())} onKeyDown={keys}>
      <header className="drive-preview-head">
        <UiButton variant="ghost" size="icon" aria-label={tr("Close the preview")} onClick={close} data-autofocus>
          <X />
        </UiButton>
        <div className="drive-preview-title">
          {item && <FileGlyph kind="file" name={item.name} size={20} />}
          <h2 title={name}>{isolate(name)}</h2>
        </div>
        {files.length > 1 && at >= 0 && (
          <span className="faint drive-preview-count" role="status">
            {tr("{at} of {n}", { at: at + 1, n: files.length })}
          </span>
        )}
        <div className="drive-preview-actions">
          <UiButton className="drive-preview-step" variant="ghost" size="icon-sm" aria-label={tr("Previous file")} disabled={!near(-1)} onClick={() => go(-1)}>
            <ChevronLeft className="rtl:rotate-180" />
          </UiButton>
          <UiButton className="drive-preview-step" variant="ghost" size="icon-sm" aria-label={tr("Next file")} disabled={!near(1)} onClick={() => go(1)}>
            <ChevronRight className="rtl:rotate-180" />
          </UiButton>
          {editor && (
            <EditorLink choice={editor} className="btn btn-primary btn-sm">
              <ExternalLink aria-hidden size={14} /> <span className="drive-preview-label">{label}</span>
            </EditorLink>
          )}
          {toDoc && (
            <EditorLink choice={toDoc} className="btn btn-default btn-sm">
              <span className="drive-preview-label">{toDoc.label}</span>
              <FileText aria-hidden size={14} className="drive-preview-icon" />
            </EditorLink>
          )}
          {item && allows(item.permission, "Manage") && (
            <UiButton variant="ghost" size="sm" aria-label={tr("Share")} onClick={() => onShare(item)}>
              <Share2 /> <span className="drive-preview-label">{tr("Share")}</span>
            </UiButton>
          )}
          <UiButton variant="ghost" size="sm" aria-label={tr("Download")} onClick={down} disabled={!item}>
            <Download /> <span className="drive-preview-label">{tr("Download")}</span>
          </UiButton>
          <UiButton variant={info ? "secondary" : "ghost"} size="icon-sm" aria-label={tr("File details")} aria-pressed={info} onClick={() => setInfo(!info)}>
            <Info />
          </UiButton>
        </div>
      </header>
      <div className="drive-preview-main" data-info={info || undefined}>
        <button type="button" className="drive-preview-nav" data-side="start" aria-label={tr("Previous file")} disabled={!near(-1)} onClick={() => go(-1)}>
          <ChevronLeft className="rtl:rotate-180" aria-hidden />
        </button>
        <div className="drive-preview-stage">{body()}</div>
        <button type="button" className="drive-preview-nav" data-side="end" aria-label={tr("Next file")} disabled={!near(1)} onClick={() => go(1)}>
          <ChevronRight className="rtl:rotate-180" aria-hidden />
        </button>
        {info && item && <Facts item={item} info={fetched.data} onDetails={() => onDetails(item)} />}
      </div>
    </dialog>
  );
}

/** Wraps a PDF so that one that cannot be drawn says why. */
function PdfFailable({ url, down, children }: { url: string; down: () => void; children: (onFail: (why: "password" | "broken") => void) => React.ReactNode }) {
  const [why, setWhy] = useState<"password" | "broken" | null>(null);
  const fail = useCallback((w: "password" | "broken") => setWhy(w), []);
  useEffect(() => setWhy(null), [url]);
  if (why)
    return (
      <StatePanel kind="failed" title={why === "password" ? tr("This PDF is protected with a password") : tr("This PDF cannot be shown")} action={<UiButton onClick={down}><Download /> {tr("Download")}</UiButton>}>
        {why === "password" ? tr("Download it and open it in a program that asks for the password.") : tr("It may be damaged. You can still download it.")}
      </StatePanel>
    );
  return <>{children(fail)}</>;
}

/** What is known of the file: its type, size, who changed it, where it is, how many versions. */
function Facts({ item, info, onDetails }: { item: Item; info?: ItemInfo; onDetails: () => void }) {
  const crumbs = info?.breadcrumbs ?? [];
  return (
    <aside className="drive-preview-info" aria-label={tr("Details of {value}", { value: shownName(item.name) })}>
      <dl className="drive-facts">
        <dt>{tr("Type")}</dt>
        <dd>{isolate(kindLabel(item.name, item.file_type) || tr("File"))}</dd>
        <dt>{tr("Size")}</dt>
        <dd>{isolate(sizeLabel(item.size) || "—")}</dd>
        <dt>{tr("Modified")}</dt>
        <dd>
          {isolate(formatDateTime(item.modified_at))}
          {item.modified_by ? tr(" by {modified_by}", { modified_by: item.modified_by }) : ""}
        </dd>
        <dt>{tr("Owner")}</dt>
        <dd>{isolate(item.owner ?? tr("Team folder"))}</dd>
        {info?.version != null && (
          <>
            <dt>{tr("Version")}</dt>
            <dd>{info.version}</dd>
          </>
        )}
        {(crumbs.length > 1 || item.path) && (
          <>
            <dt>{tr("Where")}</dt>
            <dd>{isolate(crumbs.length > 1 ? crumbs.map((c) => c.name).slice(1).join(" / ") : (item.path ?? ""))}</dd>
          </>
        )}
      </dl>
      <UiButton variant="outline" size="sm" onClick={onDetails}>
        {tr("Comments, versions and activity")}
      </UiButton>
    </aside>
  );
}
