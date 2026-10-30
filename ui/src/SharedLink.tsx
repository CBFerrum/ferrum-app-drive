// A Drive item shared by link (Drive's public link endpoints; Ferrum docs/plan/collaboration.md,
// C5): what people outside the workspace open, without signing in. A password-protected link asks
// for its password once and keeps the grant for this tab; a folder can be browsed; files preview
// (images, PDFs) and download when the link allows it.

import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, File, Folder, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage, formatDateTime } from "@ferrum/client";
import { Button, Input, Label, Skeleton } from "@ferrum/kit/primitives";
import { sizeLabel } from "./Drive";

interface Entry {
  id: string;
  kind: "file" | "folder";
  name: string;
  size?: number | null;
  content_type?: string | null;
  modified_at?: string | null;
}
interface Shared {
  link: { access: "View" | "Download"; expires_at?: string | null; downloads_left?: number | null; has_password: boolean };
  item: Entry;
  folder?: Entry;
  breadcrumbs?: { id: string; name: string }[];
  items?: Entry[];
}

/** JSON from a public endpoint. Plain fetch: a 401 here is a link's password, not the visitor's
 *  session. */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await r.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, body.error ?? "error", body.message ?? "This link does not work.");
  }
  return r.json() as Promise<T>;
}

/** A document edited live in Drive: guests read it as a page. */
const live = (e: Entry) => e.content_type === "application/vnd.ferrum.doc";
const previewable = (e: Entry) => !!e.content_type && (e.content_type.startsWith("image/") || e.content_type === "application/pdf" || live(e));
/** What a download is saved as: a live document arrives as a page. */
const savedAs = (e: Entry) => (live(e) ? e.name.replace(/\.fdoc$/i, ".html") : e.name);

export function SharedLinkPage() {
  const { tenant = "", link = "" } = useParams();
  const [params] = useSearchParams();
  const folder = params.get("folder");
  const base = `/api/site/${encodeURIComponent(tenant)}/drive/links/${encodeURIComponent(link)}`;
  const grantKey = `ferrum.drive-grant.${link}`;
  const [grant, setGrant] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(grantKey);
    } catch {
      return null;
    }
  });
  const shared = useQuery({
    queryKey: ["shared-link", tenant, link, folder, grant],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams();
      if (folder) q.set("folder", folder);
      if (grant) q.set("grant", grant);
      return call<Shared>(`${base}?${q}`, { signal });
    },
    retry: false,
  });
  const content = (file: string, inline: boolean) => {
    const q = new URLSearchParams({ file });
    if (inline) q.set("inline", "1");
    if (grant) q.set("grant", grant);
    return `${base}/content?${q}`;
  };
  const locked = shared.error instanceof ApiError && shared.error.status === 401;

  return (
    <div className="min-h-dvh bg-muted/30">
      <main className="mx-auto grid max-w-3xl gap-4 p-4 sm:p-8">
        <p className="text-sm text-muted-foreground">Shared with you through Ferrum Drive</p>
        {locked ? (
          <Unlock
            base={base}
            onGrant={(g) => {
              try {
                sessionStorage.setItem(grantKey, g);
              } catch {
                /* the grant lasts for this page only */
              }
              setGrant(g);
            }}
          />
        ) : shared.error ? (
          <div className="rounded-lg border bg-background p-6">
            <h1 className="text-lg font-semibold">This link does not work</h1>
            <p className="mt-1 text-muted-foreground">It may have expired or been turned off. Ask the person who shared it with you for a new one.</p>
          </div>
        ) : !shared.data ? (
          <Skeleton className="h-48" />
        ) : (
          <SharedItem s={shared.data} content={content} />
        )}
      </main>
    </div>
  );
}

function Unlock({ base, onGrant }: { base: string; onGrant: (grant: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ grant: string | null }>(`${base}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.grant) onGrant(r.grant);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3 rounded-lg border bg-background p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <Lock className="size-4" aria-hidden="true" /> This link has a password
      </h1>
      <Label htmlFor="link-password">Password</Label>
      <Input id="link-password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !password}>
        Open
      </Button>
    </form>
  );
}

function SharedItem({ s, content }: { s: Shared; content: (file: string, inline: boolean) => string }) {
  const download = s.link.access === "Download";
  const footer = [
    s.link.expires_at ? `This link works until ${formatDateTime(s.link.expires_at)}.` : null,
    s.link.downloads_left != null ? `${s.link.downloads_left} downloads left.` : null,
  ].filter(Boolean);
  const actions = (e: Entry) => (
    <div className="flex shrink-0 gap-1">
      {previewable(e) && (
        <Button asChild variant="ghost" size="sm">
          <a href={content(e.id, true)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${e.name}`}>
            <ExternalLink /> Open
          </a>
        </Button>
      )}
      {download && (
        <Button asChild variant="outline" size="sm">
          <a href={content(e.id, false)} download={savedAs(e)} aria-label={`Download ${e.name}`}>
            <Download /> Download
          </a>
        </Button>
      )}
    </div>
  );

  if (s.item.kind === "file")
    return (
      <section className="grid gap-4 rounded-lg border bg-background p-6">
        <div className="flex flex-wrap items-center gap-3">
          <File className="size-5 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{live(s.item) ? s.item.name.replace(/\.fdoc$/i, "") : s.item.name}</h1>
            <p className="text-sm text-muted-foreground">
              {sizeLabel(s.item.size ?? null)}
              {s.item.modified_at ? ` · changed ${formatDateTime(s.item.modified_at)}` : ""}
            </p>
          </div>
          {actions(s.item)}
        </div>
        {s.item.content_type?.startsWith("image/") && <img src={content(s.item.id, true)} alt={s.item.name} className="max-h-[70vh] w-auto rounded border object-contain" />}
        {live(s.item) && <iframe src={content(s.item.id, true)} title={s.item.name} sandbox="" className="h-[70vh] w-full rounded border bg-white" />}
        {!download && !previewable(s.item) && <p className="text-sm text-muted-foreground">This link lets you see the file's details; it does not allow downloading.</p>}
        {footer.length > 0 && <p className="text-xs text-muted-foreground">{footer.join(" ")}</p>}
      </section>
    );

  const crumbs = s.breadcrumbs ?? [];
  return (
    <section className="grid gap-3 rounded-lg border bg-background p-4 sm:p-6">
      <nav aria-label="Folders" className="flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground">/</span>}
            {i === crumbs.length - 1 ? (
              <span className="font-semibold">{c.name}</span>
            ) : (
              <Link to={i === 0 ? "?" : `?folder=${c.id}`} className="text-primary underline-offset-2 hover:underline">
                {c.name}
              </Link>
            )}
          </span>
        ))}
      </nav>
      {!s.items?.length && <p className="text-muted-foreground">This folder is empty.</p>}
      <ul className="divide-y">
        {s.items?.map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-2">
            {e.kind === "folder" ? <Folder className="size-4 text-muted-foreground" aria-hidden="true" /> : <File className="size-4 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              {e.kind === "folder" ? (
                <Link to={`?folder=${e.id}`} className="truncate font-medium text-primary underline-offset-2 hover:underline">
                  {e.name}
                </Link>
              ) : (
                <span className="block truncate">{e.name}</span>
              )}
              {e.kind === "file" && <span className="text-xs text-muted-foreground">{sizeLabel(e.size ?? null)}</span>}
            </div>
            {e.kind === "file" && actions(e)}
          </li>
        ))}
      </ul>
      {footer.length > 0 && <p className="text-xs text-muted-foreground">{footer.join(" ")}</p>}
    </section>
  );
}
