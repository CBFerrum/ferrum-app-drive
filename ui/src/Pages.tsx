// Drive's pages besides its lists and editors: the viewer (`/drive/view/{file}`), a link to an
// item (`/drive/item/{id}`, where `/open/DriveFile/{id}` leads), and what Drive does for other apps
// (Ferrum docs/plan/apps-ui.md §11.3, §11.4): the `pick file`, `preview file` and `share file`
// intents, each in the asking app's dialog, and the details panel (`drive.details`) beside another
// app's page. They talk to the asking page only through the shell.

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, download, errorMessage, formatDateTime, shell, type IntentRequest } from "@ferrum/client";
import { Button, EmptyState, Spinner, toast } from "@ferrum/kit";
import { DetailsPanel, type ItemInfo } from "./Details";
import { FileGlyph, isLiveDoc, shownName, sizeLabel } from "./Drive";
import { type Shareable, ShareDialog } from "./Share";

interface Found {
  id: string;
  kind: "file" | "folder";
  name: string;
  size: number | null;
  modified_at: string;
  path?: string | null;
}

/** What the `pick file` intent gives back: files the asking app may fetch (`url`) with the
 *  person's own rights. */
export interface PickedFile {
  id: string;
  name: string;
  size: number | null;
  url: string;
}

const contentUrl = (id: string) => `/api/app/drive/files/${encodeURIComponent(id)}/content`;
const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
const isPdf = (name: string) => /\.pdf$/i.test(name);

function useSpace() {
  return useQuery({
    queryKey: ["drive", "space"],
    queryFn: ({ signal }) => api.get<{ id: string; root_folder: string }>("/api/app/drive/space", undefined, signal),
  });
}

function useItem(id: string | undefined) {
  return useQuery({
    queryKey: ["drive", "item", id],
    queryFn: ({ signal }) => api.get<ItemInfo>("/api/app/drive/item_info", { item: id }, signal),
    enabled: !!id,
    retry: false,
  });
}

/** The intent this page answers, once the asking page has said. */
function useIntent() {
  const [req, setReq] = useState<IntentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    shell()
      .intent.request()
      .then(setReq, (e: unknown) => setError(errorMessage(e)));
  }, []);
  return { req, error };
}

/** A file as Drive's viewer shows it: images and live documents in the page, PDFs in the
 *  browser's own viewer; anything else offers its download. */
export function Viewer({ item }: { item: Pick<ItemInfo, "id" | "name"> }) {
  const url = contentUrl(item.id);
  if (isImage(item.name)) return <img className="drive-viewer-image" src={`${url}?inline=1`} alt={item.name} />;
  // Its page runs nothing (the response is sandboxed), and so is the frame.
  if (isLiveDoc(item.name)) return <iframe className="drive-viewer" title={item.name} src={`${url}?format=html&inline=1`} sandbox="" />;
  return (
    <div className="drive-viewer-none">
      <p className="muted">{isPdf(item.name) ? "PDFs open in your browser's viewer." : "Drive cannot show this kind of file; download it to open it."}</p>
      <div className="row" style={{ gap: 8 }}>
        {isPdf(item.name) && (
          <a className="btn btn-default btn-sm" href={`${url}?inline=1`} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        )}
        <Button size="sm" icon="download" onClick={() => void download(url, item.name).catch((e: unknown) => toast(errorMessage(e), "error"))}>
          Download
        </Button>
      </div>
    </div>
  );
}

/** `/drive/view/:file`: a file in Drive's viewer. */
export function ViewPage() {
  const { file } = useParams();
  const item = useItem(file);
  useEffect(() => {
    if (item.data) shell().title(item.data.name);
  }, [item.data]);
  if (item.error)
    return (
      <EmptyState title="This file cannot be opened" icon="file">
        <p className="muted">{errorMessage(item.error)}</p>
        <Link to="/drive">Go to Drive</Link>
      </EmptyState>
    );
  if (!item.data) return <Spinner label="Opening the file" />;
  const back = item.data.parent ? `/drive/${item.data.parent}?item=${item.data.id}` : "/drive";
  return (
    <div className="drive-view-page">
      <div className="editor-bar">
        <Link className="btn btn-default btn-sm" to={back}>
          Back
        </Link>
        <strong>{shownName(item.data.name)}</strong>
        <span className="faint">
          {sizeLabel(item.data.size ?? null)} · {formatDateTime(item.data.modified_at)}
        </span>
      </div>
      <Viewer item={item.data} />
    </div>
  );
}

/** `/drive/item/:id` (`/open/DriveFile/{id}`, `/open/DriveFolder/{id}` lead here): the item in its
 *  folder, with its details. */
export function ItemPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const item = useItem(id);
  useEffect(() => {
    const it = item.data;
    if (!it) return;
    if (it.kind === "folder") navigate(`/drive/${it.id}`, { replace: true });
    else navigate(it.parent ? `/drive/${it.parent}?item=${it.id}` : `/drive?item=${it.id}`, { replace: true });
  }, [item.data, navigate]);
  if (item.error)
    return (
      <EmptyState title="This item cannot be opened" icon="file">
        <p className="muted">{errorMessage(item.error)}</p>
        <Link to="/drive">Go to Drive</Link>
      </EmptyState>
    );
  return <Spinner label="Opening" />;
}

/** `drive/_intent/pick` (`pick file`): files for another app, found by name or among recent
 *  ones. `data`: `{multiple?, title?}`; the result: `{files: PickedFile[]}`. */
export function PickPage() {
  const { req, error } = useIntent();
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Found[]>([]);
  const opts = (req?.data ?? {}) as { multiple?: boolean; title?: string };
  const found = useQuery({
    queryKey: ["drive", "pick", query],
    queryFn: ({ signal }) =>
      (query
        ? api.get<{ items: Found[] }>("/api/app/drive/search", { query, limit: 50 }, signal)
        : api.get<{ items: Found[] }>("/api/app/drive/recent", { limit: 50 }, signal)
      ).then((r) => r.items.filter((i) => i.kind === "file")),
    enabled: !!req,
  });
  if (error) return <EmptyState title="Nothing to pick">{error}</EmptyState>;
  if (!req) return <Spinner label="Opening Drive" />;
  const toggle = (f: Found) =>
    setChosen((c) => (c.some((x) => x.id === f.id) ? c.filter((x) => x.id !== f.id) : opts.multiple ? [...c, f] : [f]));
  const done = () => shell().intent.done({ files: chosen.map((f) => ({ id: f.id, name: f.name, size: f.size, url: contentUrl(f.id) })) });
  return (
    <div className="drive-intent">
      <h1 className="page-title">{opts.title ?? (opts.multiple ? "Choose files from Drive" : "Choose a file from Drive")}</h1>
      <form
        role="search"
        className="drive-search"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setQuery(typed.trim());
        }}
      >
        <label htmlFor={fieldId} className="sr-only">
          Search Drive
        </label>
        <input id={fieldId} className="input" type="search" placeholder="Search Drive" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </form>
      <p className="faint">{query ? `Files named like “${query}”` : "Files you worked on lately"}</p>
      {found.isPending ? (
        <Spinner label="Looking" />
      ) : found.error ? (
        <p className="muted">{errorMessage(found.error)}</p>
      ) : !found.data?.length ? (
        <p className="muted">No files here.</p>
      ) : (
        <ul className="drive-pick" role="listbox" aria-multiselectable={!!opts.multiple} aria-label="Files">
          {found.data.map((f) => {
            const on = chosen.some((x) => x.id === f.id);
            return (
              <li key={f.id} role="option" aria-selected={on}>
                <button type="button" className={on ? "drive-pick-item drive-pick-on" : "drive-pick-item"} onClick={() => toggle(f)} onDoubleClick={() => !opts.multiple && shell().intent.done({ files: [{ id: f.id, name: f.name, size: f.size, url: contentUrl(f.id) }] })}>
                  <FileGlyph kind="file" name={f.name} size={20} />
                  <span className="drive-pick-name">{shownName(f.name)}</span>
                  <span className="faint">
                    {sizeLabel(f.size)} · {formatDateTime(f.modified_at)}
                    {f.path ? ` · ${f.path}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="drive-intent-actions">
        <Button onClick={() => shell().intent.cancel()}>Cancel</Button>
        <Button variant="primary" disabled={!chosen.length} onClick={done}>
          {chosen.length > 1 ? `Choose ${chosen.length} files` : "Choose"}
        </Button>
      </div>
    </div>
  );
}

/** `drive/_intent/preview` (`preview file`, `data`: `{id}`): the file without leaving the asking
 *  app; done when closed. */
export function PreviewPage() {
  const { req, error } = useIntent();
  const id = (req?.data as { id?: string } | null)?.id;
  const item = useItem(id);
  if (error || item.error) return <EmptyState title="This file cannot be shown">{error ?? errorMessage(item.error)}</EmptyState>;
  if (!item.data) return <Spinner label="Opening the file" />;
  return (
    <div className="drive-intent">
      <div className="editor-bar">
        <strong>{shownName(item.data.name)}</strong>
        <span className="faint">{sizeLabel(item.data.size ?? null)}</span>
        <span className="editor-bar-end">
          <a className="btn btn-default btn-sm" href={item.data.parent ? `/drive/${item.data.parent}?item=${item.data.id}` : "/drive"} onClick={(e) => (e.preventDefault(), shell().navigate(e.currentTarget.getAttribute("href")!))}>
            Open in Drive
          </a>
          <Button size="sm" onClick={() => shell().intent.done()}>
            Close
          </Button>
        </span>
      </div>
      <Viewer item={item.data} />
    </div>
  );
}

/** `drive/_intent/share` (`share file`, `data`: `{id}`): Drive's share dialog for another app's
 *  page (Docs' editor); the result says whether anything changed. */
export function ShareIntentPage() {
  const { req, error } = useIntent();
  const id = (req?.data as { id?: string } | null)?.id;
  const item = useItem(id);
  const space = useSpace();
  if (error || item.error || space.error) return <EmptyState title="This cannot be shared">{error ?? errorMessage(item.error ?? space.error)}</EmptyState>;
  if (!item.data || !space.data) return <Spinner label="Opening sharing" />;
  const shareable: Shareable = { id: item.data.id, name: item.data.name, kind: item.data.kind };
  return <ShareDialog item={shareable} space={space.data.id} onClose={() => shell().intent.done({ shared: true })} />;
}

/** `drive/_panel/details` (the `drive.details` panel; context `{file}`): a file's comments,
 *  versions and activity beside another app's page. */
export function DetailsPanelPage() {
  const [file, setFile] = useState(() => (shell().sidepanel.context() as { file?: string } | null)?.file);
  const [sharing, setSharing] = useState<Shareable | null>(null);
  const space = useSpace();
  useEffect(() => {
    const off = shell().on("panel-context", (c) => setFile((c as { file?: string } | null)?.file));
    return () => off?.();
  }, []);
  if (!file) return <EmptyState title="No file">Open the panel from a file.</EmptyState>;
  if (space.error) return <EmptyState title="Drive is not available">{errorMessage(space.error)}</EmptyState>;
  if (!space.data) return <Spinner label="Loading" />;
  return (
    <div className="drive-panel">
      <DetailsPanel id={file} space={space.data.id} inEditor onClose={() => shell().sidepanel.close()} onShare={setSharing} />
      {sharing && <ShareDialog item={sharing} space={space.data.id} onClose={() => setSharing(null)} />}
    </div>
  );
}
