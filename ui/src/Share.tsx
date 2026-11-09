// Sharing a Drive item in one dialog: who may open it and how (a person with a role and an end
// date), who has access already and why (given to it, coming down from a folder above, or sent to
// a guest by link), and public links with the options a workspace may require (a password, an end
// date, a limit on downloads, a note) shown before they would fail. Someone outside the workspace
// (a guest) gets a link of their own by email, as a Viewer.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage, formatMoment, relativeTime, todayIso, t, isolate } from "@ferrum/client";
import { Alert, Badge, Button, Dialog, Field, Spinner, toast } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";
import { type Share, type Shares, groupShares, shareFor } from "./access";
import { type ItemInfo, type Shareable, shownName } from "./files";
import {
  type LinkDraft,
  type LinkPolicy,
  NOTE_MAX,
  OPEN_POLICY,
  type PublicLink,
  blankDraft,
  departure,
  latestEnd,
  linkBody,
  makePassword,
  problems,
  rules,
  stateOf,
} from "./linkPolicy";
import { ROLES, itemLink, roleLabel } from "./roles";

const day = (iso: string) => formatMoment(iso, { dateStyle: "medium" });

/** How a link reads in a list: what it allows, what it asks for, how it has been used. */
function facts(l: PublicLink, ended: boolean): string[] {
  const out: string[] = [];
  if (l.has_password) out.push("password");
  if (l.expires_at) out.push(`${ended ? "ended" : "ends"} ${day(l.expires_at)}`);
  if (l.max_downloads) out.push(t("{value} of {max_downloads} uses", { value: l.download_count ?? 0, max_downloads: l.max_downloads }));
  else if (l.download_count) out.push(`${l.download_count} ${l.download_count === 1 ? "use" : "uses"}`);
  out.push(l.last_accessed_at ? t("last opened {value}", { value: relativeTime(l.last_accessed_at) }) : t("not opened yet"));
  return out;
}

export function ShareDialog({ item, space, onClose, onOpenFolder }: { item: Shareable; space: string; onClose: () => void; onOpenFolder?: (folder: string) => void }) {
  const qc = useQueryClient();
  const formId = useId();
  const today = todayIso();
  const people = usePeople().data?.users ?? [];
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState("View");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [show, setShow] = useState(false);
  const [made, setMade] = useState<{ url: string; password: string; access: string } | null>(null);
  const act = (action: string, params: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${space}/actions/${action}`, params);
  const shares = useQuery({ queryKey: ["drive", "shares", item.id], queryFn: () => act("list_shares", { item: item.id }) as Promise<Shares> });
  const links = useQuery({ queryKey: ["drive", "links", item.id], queryFn: () => act("list_links", { item: item.id }) as Promise<{ links: PublicLink[]; policy: LinkPolicy }> });
  // The folders above the item, by name, for the access that comes down from them.
  const above = useQuery({ queryKey: ["drive", "item", item.id], queryFn: ({ signal }) => api.get<ItemInfo>("/api/app/drive/item_info", { item: item.id }, signal) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["drive"] });

  const policy = links.data?.policy ?? OPEN_POLICY;
  const form = draft ?? blankDraft(policy, today);
  const latest = latestEnd(policy, today);
  const errors = tried ? problems(form, policy, today) : {};
  const edit = (change: Partial<LinkDraft>) => setDraft({ ...form, ...change });

  const typed = email.trim().toLowerCase();
  const outside = /^\S+@\S+\.\S+$/.test(typed) && !people.some((p) => p.email.toLowerCase() === typed);
  const nameOf = (address?: string | null) => people.find((p) => p.email.toLowerCase() === address?.toLowerCase())?.full_name;
  // What stops a person outside the workspace being added, said before they try.
  const guestNote = !outside
    ? null
    : !policy.allow_public_links
      ? { stop: true, text: t("Public links are turned off in this workspace, so this can only be shared with people in it.") }
      : policy.link_password_required
        ? { stop: true, text: t("Links in this workspace need a password. Make a link with a password under Link, and send them both.") }
        : permission !== "View"
          ? { stop: true, text: t("Someone outside the workspace can only be a Viewer.") }
          : { stop: false, text: t("Outside the workspace: they get a link by email, as a Viewer.") };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("{what} copied", { what }));
    } catch {
      toast(t("Copy this {what}: {text}", { what: what.toLowerCase(), text }));
    }
  };
  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!typed || guestNote?.stop) return;
    void run("add", async () => {
      const done = (await act("share", { item: item.id, email: typed, permission, expires_at: until || undefined })) as { guest?: boolean; mailed?: boolean; page?: string | null };
      if (!done.guest) toast(t("Shared with {typed} as {permission}", { typed, permission: roleLabel(permission) }));
      else if (done.mailed) toast(t("{typed} is outside the workspace: a link was sent to them", { typed }));
      // A guest's link comes whole, on the server's public address.
      else if (done.page) await copy(done.page, t("Their link"));
      setEmail("");
      setUntil("");
    });
  };
  // A new role replaces the old grant, so the end date is sent again.
  const change = (s: Share, next: string) =>
    run(`role-${s.id}`, async () => {
      await act("share", { item: item.id, ...(s.email ? { email: s.email } : { role: s.role }), permission: next, expires_at: s.expires_at || undefined });
      toast(t("{s} is now {next}", { s: shareFor(s), next: roleLabel(next) }));
    });
  const remove = (s: Share) =>
    run(`share-${s.id}`, async () => {
      await act("unshare", { item: item.id, share: s.id });
      toast(t("{s} no longer has access", { s: shareFor(s) }));
    });
  const revoke = (l: PublicLink) =>
    run(`link-${l.id}`, async () => {
      await act("revoke_link", { item: item.id, link: l.id });
      toast(l.email ? t("{email} no longer has access", { email: l.email }) : t("The link no longer works"));
    });
  const publish = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems(form, policy, today)).length) return;
    void run("publish", async () => {
      const link = (await act("create_link", linkBody(item.id, form))) as { page: string };
      const url = `${location.origin}${link.page}`;
      setMade({ url, password: form.password, access: form.access });
      setDraft(null);
      setTried(false);
      setShow(false);
      await copy(url, "Link");
    });
  };

  const current = shares.data;
  const { direct, inherited } = groupShares(current?.shares ?? [], above.data?.breadcrumbs ?? []);
  const open = (links.data?.links ?? []).filter((l) => !l.revoked && !l.email);
  const guests = (links.data?.links ?? []).filter((l) => l.email && !l.revoked && l.active !== false);
  const row = (s: Share, editable: boolean) => {
    const who = s.email ? nameOf(s.email) || s.email : shareFor(s);
    return (
      <li key={s.id} className="share-row">
        <span className="share-who">
          <strong>{isolate(who)}</strong>
          {(s.email && who !== s.email) || s.expires_at ? (
            <span className="faint">
              {s.email && who !== s.email ? s.email : ""}
              {s.expires_at ? t("{value}until {value2}", { value: s.email && who !== s.email ? " · " : "", value2: day(s.expires_at) }) : ""}
            </span>
          ) : null}
        </span>
        {editable ? (
          <>
            <select className="input share-role" value={s.permission} disabled={busy === `role-${s.id}`} aria-label={t("Role of {who}", { who })} onChange={(e) => void change(s, e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.permission} value={r.permission}>
                  {isolate(r.label)}
                </option>
              ))}
            </select>
            <Button size="sm" variant="ghost" aria-label={t("Remove {who}", { who })} loading={busy === `share-${s.id}`} onClick={() => void remove(s)}>
              {t("Remove")}
            </Button>
          </>
        ) : (
          <Badge tone="blue">{isolate(roleLabel(s.permission))}</Badge>
        )}
      </li>
    );
  };

  return (
    <Dialog
      open
      wide
      title={t("Share “{value}”", { value: shownName(item.name) })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void copy(itemLink(item.id, item.kind), "Link")} icon="copy" title={t("A link for people who already have access")}>
            {t("Copy link")}
          </Button>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            {t("Done")}
          </Button>
        </>
      }
    >
      <div className="share-grid">
        <section aria-labelledby={`${formId}-people`}>
          <h3 id={`${formId}-people`} className="share-head">
            {t("People")}
          </h3>
          <form className="share-add" onSubmit={add} aria-label={t("Add people")}>
            <Field label={t("Person")} htmlFor={`${formId}-email`}>
              <input
                id={`${formId}-email`}
                className="input"
                type="email"
                list={`${formId}-people-list`}
                placeholder={t("name@company.com")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
              <datalist id={`${formId}-people-list`}>
                {people.map((p) => (
                  <option key={p.id} value={p.email}>
                    {isolate(p.full_name)}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label={t("Role")} htmlFor={`${formId}-role`}>
              <select id={`${formId}-role`} className="input" value={permission} onChange={(e) => setPermission(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r.permission} value={r.permission}>
                    {isolate(r.label)}: {isolate(r.hint)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Until")} htmlFor={`${formId}-until`} hint={t("Optional")}>
              <input id={`${formId}-until`} className="input" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
            {guestNote && (
              <p className={guestNote.stop ? "share-note share-note-stop" : "share-note"} role="status">
                {isolate(guestNote.text)}
              </p>
            )}
            <Button type="submit" variant="primary" loading={busy === "add"} disabled={!typed || !!guestNote?.stop}>
              {t("Share")}
            </Button>
          </form>

          <h3 className="share-head">{t("Who has access")}</h3>
          {shares.isLoading ? (
            <Spinner label={t("Loading who has access")} />
          ) : shares.error ? (
            <p className="muted">{isolate(errorMessage(shares.error))}</p>
          ) : (
            <>
              <ul className="share-list">
                {current?.owner && (
                  <li className="share-row">
                    <span className="share-who">
                      <strong>{nameOf(current.owner) || current.owner}</strong>
                      {nameOf(current.owner) && <span className="faint">{isolate(current.owner)}</span>}
                    </span>
                    <Badge>{t("Owner")}</Badge>
                  </li>
                )}
                {current?.team && (
                  <li className="share-row">
                    <span className="share-who">
                      <strong>{t("Team folder “{name}”", { name: current.team.name })}</strong>
                      <span className="faint">{current.team.members.length} {current.team.members.length === 1 ? t("member") : t("members")}</span>
                    </span>
                    <Badge>{t("Team")}</Badge>
                  </li>
                )}
                {direct.map((s) => row(s, true))}
                {guests.map((l) => (
                  <li key={l.id} className="share-row">
                    <span className="share-who">
                      <strong>{isolate(l.email ?? "")}</strong>
                      <span className="faint">{(l.expires_at ? t("guest · until {value}", { value: day(l.expires_at) }) : t("guest"))}</span>
                    </span>
                    <Badge tone="amber">{t("Guest")}</Badge>
                    <Button size="sm" variant="ghost" aria-label={t("Remove {email}", { email: String(l.email) })} loading={busy === `link-${l.id}`} onClick={() => void revoke(l)}>
                      {t("Remove")}
                    </Button>
                  </li>
                ))}
                {!direct.length && !guests.length && !current?.team && !inherited.length && <li className="faint">{t("Nobody else yet.")}</li>}
              </ul>
              {inherited.map((g) => (
                <div key={g.folder} className="share-inherited">
                  <div className="share-inherited-head">
                    <span>
                      {t("Comes down from the folder")} <strong>“{isolate(g.name)}”</strong>
                    </span>
                    {onOpenFolder && (
                      <Button size="sm" variant="ghost" onClick={() => onOpenFolder(g.folder)}>
                        {t("Open folder")}
                      </Button>
                    )}
                  </div>
                  <ul className="share-list">{g.shares.map((s) => row(s, false))}</ul>
                </div>
              ))}
            </>
          )}
        </section>

        <section aria-labelledby={`${formId}-link`}>
          <h3 id={`${formId}-link`} className="share-head">
            {t("Link")}
          </h3>
          {links.isLoading ? (
            <Spinner label={t("Loading links")} />
          ) : links.error ? (
            <p className="muted">{isolate(errorMessage(links.error))}</p>
          ) : !policy.allow_public_links ? (
            <p className="muted">{t("Public links are turned off for this workspace.")}</p>
          ) : (
            <>
              <p className="faint">{t("Anyone with a link can open this without signing in.")}</p>
              {rules(policy) && <Alert tone="info">{isolate(rules(policy) ?? "")}</Alert>}
              {made && (
                <div className="share-made" role="status">
                  <strong>{t("Your link is ready")}</strong>
                  <div className="share-copy">
                    <input className="input" readOnly value={made.url} aria-label={t("The new link")} onFocus={(e) => e.currentTarget.select()} />
                    <Button icon="copy" onClick={() => void copy(made.url, "Link")}>
                      {t("Copy")}
                    </Button>
                  </div>
                  <p className="faint">
                    {(made.password ? t("It is copied. Drive cannot show it again once you close this. Send the password separately.") : t("It is copied. Drive cannot show it again once you close this."))}
                  </p>
                </div>
              )}
              <form className="share-link-form" onSubmit={publish} noValidate aria-label={t("New link")}>
                <Field label={t("Anyone with the link can")} htmlFor={`${formId}-access`}>
                  <select id={`${formId}-access`} className="input" value={form.access} onChange={(e) => edit({ access: e.target.value as LinkDraft["access"] })}>
                    <option value="View">{t("View")}</option>
                    <option value="Download">{t("View and download")}</option>
                  </select>
                </Field>
                <Field
                  label={t("Ends on")}
                  htmlFor={`${formId}-ends`}
                  required={!!latest}
                  error={errors.expires}
                  hint={latest ? (policy.max_link_days === 1 ? t("Required: at most {max_link_days} day", { max_link_days: policy.max_link_days }) : t("Required: at most {max_link_days} days", { max_link_days: policy.max_link_days })) : t("Optional")}
                >
                  <input id={`${formId}-ends`} className="input" type="date" min={today} max={latest ?? undefined} value={form.expires} onChange={(e) => edit({ expires: e.target.value })} />
                </Field>
                <Field
                  label={t("Password")}
                  htmlFor={`${formId}-password`}
                  required={policy.link_password_required}
                  error={errors.password}
                  hint={policy.link_password_required ? t("Required: at least 8 characters") : t("Optional: at least 8 characters")}
                >
                  <div className="share-copy">
                    <input
                      id={`${formId}-password`}
                      className="input"
                      type={show ? "text" : "password"}
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(e) => edit({ password: e.target.value })}
                    />
                    <Button
                      onClick={() => {
                        edit({ password: makePassword((n) => Array.from(crypto.getRandomValues(new Uint32Array(n)))) });
                        setShow(true);
                      }}
                    >
                      {t("Make one")}
                    </Button>
                    <Button aria-pressed={show} onClick={() => setShow(!show)}>
                      {show ? t("Hide") : t("Show")}
                    </Button>
                  </div>
                </Field>
                <Field label={t("Limit on uses")} htmlFor={`${formId}-limit`} error={errors.limit} hint={t("Optional: it stops working after this many downloads or views")}>
                  <input id={`${formId}-limit`} className="input" inputMode="numeric" value={form.limit} onChange={(e) => edit({ limit: e.target.value })} />
                </Field>
                <Field label={t("Note")} htmlFor={`${formId}-note`} error={errors.note} hint={t("Optional: shown to people who open the link ({length} of {NOTE_MAX})", { length: form.note.length, NOTE_MAX })}>
                  <textarea id={`${formId}-note`} className="textarea" rows={2} maxLength={NOTE_MAX + 40} value={form.note} onChange={(e) => edit({ note: e.target.value })} />
                </Field>
                <Field
                  label={t("Answered for by")}
                  htmlFor={`${formId}-answerable`}
                  error={errors.answerable}
                  hint={t("Optional: someone who can manage this. The link is then the workspace's and stays when you leave; otherwise it goes with you.")}
                >
                  <input
                    id={`${formId}-answerable`}
                    className="input"
                    type="email"
                    list={`${formId}-people-list`}
                    autoComplete="off"
                    value={form.answerable}
                    onChange={(e) => edit({ answerable: e.target.value })}
                  />
                </Field>
                <Button type="submit" variant="primary" loading={busy === "publish"}>
                  {t("Make a link")}
                </Button>
              </form>

              {open.length > 0 && (
                <>
                  <h4 className="share-subhead">{t("Links already made")}</h4>
                  <ul className="share-list">
                    {open.map((l) => {
                      const state = stateOf(l);
                      const left = departure(l, (e) => nameOf(e) || e);
                      return (
                        <li key={l.id} className="share-link">
                          <div className="share-who">
                            <span className="share-link-head">
                              <strong>{l.access === "Download" ? t("View and download") : t("View")}</strong>
                              <Badge tone={state === "active" ? "green" : "neutral"}>{state === "active" ? t("Working") : state === "ended" ? t("Ended") : t("Used up")}</Badge>
                            </span>
                            <span className="faint">{isolate(facts(l, state === "ended").join(" · "))}</span>
                            {l.belongs_to === "The Workspace" && (
                              <span className="faint">{t("The workspace's, answered for by {who}", { who: isolate(nameOf(l.answerable) || l.answerable || "") })}</span>
                            )}
                            {left && <span className="faint">{left}</span>}
                            {l.note && <span className="share-link-note">“{isolate(l.note)}”</span>}
                          </div>
                          <Button size="sm" variant="ghost" loading={busy === `link-${l.id}`} onClick={() => void revoke(l)}>
                            {t("Turn off")}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="faint">{t("A link cannot be shown again after it is made.")}</p>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
