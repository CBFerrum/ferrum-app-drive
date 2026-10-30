// Sharing a Drive item (Drive's share, unshare, list_shares and link actions): people with a role
// (Viewer, Commenter, Editor or Manager) and an optional end date, the link people in the
// workspace open, and public links where the workspace allows them. Someone outside the workspace
// (a guest) gets a link of their own by email, as a Viewer.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage, formatDate } from "@ferrum/client";
import { Badge, Button, Dialog, Field, Spinner, toast } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";
import { shownName } from "./Drive";

export interface Shareable {
  id: string;
  name: string;
  kind: "file" | "folder";
}

interface Share {
  id: string;
  email?: string | null;
  role?: string | null;
  permission: string;
  expires_at?: string | null;
  shared_by?: string | null;
}
interface Shares {
  owner?: string | null;
  team?: { id: string; name: string; members: { member: string; role: string }[] } | null;
  shares: Share[];
}
interface PublicLink {
  id: string;
  access: string;
  has_password: boolean;
  expires_at?: string | null;
  max_downloads?: number | null;
  download_count?: number;
  revoked?: boolean;
  active?: boolean;
  /** The guest it was sent to; none for a link anyone may hold. */
  email?: string | null;
}

/** The roles Drive grants, with what each may do. */
export const ROLES = [
  { permission: "View", label: "Viewer", hint: "open and download" },
  { permission: "Comment", label: "Commenter", hint: "also comment" },
  { permission: "Edit", label: "Editor", hint: "also change, upload, rename and move" },
  { permission: "Manage", label: "Manager", hint: "also share" },
] as const;

export const roleLabel = (permission: string) => ROLES.find((r) => r.permission === permission)?.label ?? permission;

/** The address people in the workspace open: Drive shows the item, or offers to ask for access. */
export const itemLink = (id: string) => `${location.origin}/open/DriveFile/${encodeURIComponent(id)}`;

export function ShareDialog({ item, space, onClose }: { item: Shareable; space: string; onClose: () => void }) {
  const qc = useQueryClient();
  const formId = useId();
  const people = usePeople().data?.users ?? [];
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState("View");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const act = (action: string, params: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${space}/actions/${action}`, params);
  const shares = useQuery({
    queryKey: ["drive", "shares", item.id],
    queryFn: () => act("list_shares", { item: item.id }) as Promise<Shares>,
  });
  const links = useQuery({
    queryKey: ["drive", "links", item.id],
    queryFn: () => act("list_links", { item: item.id }) as Promise<{ links: PublicLink[] }>,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["drive"] });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const done = (await act("share", { item: item.id, email: email.trim(), permission, expires_at: until || undefined })) as { guest?: boolean; mailed?: boolean; page?: string | null };
      if (!done.guest) toast(`Shared with ${email.trim()} as ${roleLabel(permission)}`);
      else if (done.mailed) toast(`${email.trim()} is outside the workspace: a link was sent to them`);
      else if (done.page) await copy(`${done.page}`, "Their link");
      setEmail("");
      setUntil("");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: Share) => {
    try {
      await act("unshare", { item: item.id, share: s.id });
      toast(`${s.email ?? s.role} no longer has access`);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast(`Copy this ${what.toLowerCase()}: ${text}`);
    }
  };
  const publish = async () => {
    try {
      const made = (await act("create_link", { item: item.id, access: "View" })) as { page: string };
      await copy(`${location.origin}${made.page}`, "Public link");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const revoke = async (l: PublicLink) => {
    try {
      await act("revoke_link", { item: item.id, link: l.id });
      toast(l.email ? `${l.email} no longer has access` : "The public link no longer works");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const current = shares.data;
  const live = (links.data?.links ?? []).filter((l) => !l.revoked && !l.email);
  const guests = (links.data?.links ?? []).filter((l) => l.email && !l.revoked && l.active !== false);
  return (
    <Dialog
      open
      title={`Share “${shownName(item.name)}”`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void copy(itemLink(item.id), "Link")} icon="copy">
            Copy link
          </Button>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <form className="share-add" onSubmit={add} aria-label="Add people">
        <Field label="Person" htmlFor={`${formId}-email`} hint="Someone outside the workspace gets a link by email, as a Viewer">
          <input
            id={`${formId}-email`}
            className="input"
            type="email"
            list={`${formId}-people`}
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <datalist id={`${formId}-people`}>
            {people.map((p) => (
              <option key={p.id} value={p.email}>
                {p.full_name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Role" htmlFor={`${formId}-role`}>
          <select id={`${formId}-role`} className="input" value={permission} onChange={(e) => setPermission(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.permission} value={r.permission}>
                {r.label}: {r.hint}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Until" htmlFor={`${formId}-until`} hint="Optional">
          <input id={`${formId}-until`} className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()}>
          Share
        </Button>
      </form>

      <h3 className="share-head">People with access</h3>
      {shares.isLoading ? (
        <Spinner label="Loading who has access" />
      ) : shares.error ? (
        <p className="muted">{errorMessage(shares.error)}</p>
      ) : (
        <ul className="share-list">
          {current?.owner && (
            <li>
              <span>{current.owner}</span>
              <Badge>Owner</Badge>
            </li>
          )}
          {current?.team && (
            <li>
              <span>
                Members of the team folder “{current.team.name}” ({current.team.members.length})
              </span>
              <Badge>Team</Badge>
            </li>
          )}
          {current?.shares.map((s) => (
            <li key={s.id}>
              <span>
                {s.email ?? `Everyone with the role ${s.role}`}
                {s.expires_at && <span className="faint"> · until {formatDate(s.expires_at)}</span>}
              </span>
              <Badge tone="blue">{roleLabel(s.permission)}</Badge>
              <Button size="sm" variant="ghost" aria-label={`Remove ${s.email ?? s.role}`} onClick={() => void remove(s)}>
                Remove
              </Button>
            </li>
          ))}
          {guests.map((l) => (
            <li key={l.id}>
              <span>
                {l.email}
                {l.expires_at && <span className="faint"> · until {formatDate(l.expires_at)}</span>}
              </span>
              <Badge tone="amber">Guest</Badge>
              <Button size="sm" variant="ghost" aria-label={`Remove ${l.email}`} onClick={() => void revoke(l)}>
                Remove
              </Button>
            </li>
          ))}
          {!current?.shares.length && !current?.team && !guests.length && <li className="faint">Nobody else yet.</li>}
        </ul>
      )}

      <h3 className="share-head">Public links</h3>
      <p className="faint">Anyone with a public link can open this without signing in.</p>
      <ul className="share-list">
        {live.map((l) => (
          <li key={l.id}>
            <span>
              {l.access === "Download" ? "View and download" : "View"}
              {l.has_password && " · password"}
              {l.expires_at && ` · until ${formatDate(l.expires_at)}`}
              {l.max_downloads ? ` · ${l.download_count ?? 0} of ${l.max_downloads} downloads` : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void revoke(l)}>
              Turn off
            </Button>
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={() => void publish()}>
        New public link
      </Button>
    </Dialog>
  );
}
