// Team folders: a shared place for a department with its own space. Anyone who manages one sees its
// members and changes their roles; Drive administrators make team folders and set how much space
// each may use.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Button, Dialog, EmptyState, Field, Spinner, confirmDialog, toast } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";
import { type Shares, addresses } from "./access";
import { each } from "./bulk";
import { Meter } from "./Meter";
import { ROLES } from "./roles";
import { gigabytesOf, leftLabel, megabytesOf, spaceLabel } from "./usage";
import { useUsage } from "./useDrive";

const TEAM_ROLES = ROLES.map((r) => ({ id: r.label, hint: r.hint }));

/** The roles a team folder gives its members are named, not levelled: Viewer, Commenter, Editor, Manager. */
function RoleSelect({ value, onChange, id, label, disabled }: { value: string; onChange: (role: string) => void; id?: string; label?: string; disabled?: boolean }) {
  return (
    <select id={id} className="input share-role" value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {TEAM_ROLES.map((r) => (
        <option key={r.id} value={r.id}>
          {isolate(r.id)}
        </option>
      ))}
    </select>
  );
}

/** Several people at once, each with the role chosen: the people typed or pasted as addresses. */
function AddPeople({ role, setRole, text, setText, id }: { role: string; setRole: (r: string) => void; text: string; setText: (t: string) => void; id: string }) {
  const people = usePeople().data?.users ?? [];
  const typed = addresses(text);
  const unknown = typed.emails.filter((e) => !people.some((p) => p.email.toLowerCase() === e));
  return (
    <>
      <Field label={tr("People")} htmlFor={`${id}-people`} hint={tr("Addresses, one after another: separate them with commas, spaces or lines")}>
        <textarea id={`${id}-people`} className="textarea" rows={2} placeholder="ana@company.com, ben@company.com" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
      {typed.rest.length > 0 && <p className="share-note share-note-stop">{tr("Not an address:")} {isolate(typed.rest.join(", "))}</p>}
      {unknown.length > 0 && <p className="share-note">{tr("Not people of this workspace:")} {isolate(unknown.join(", "))}{tr(". Drive will say so for each.")}</p>}
      <Field label={tr("Role")} htmlFor={`${id}-role`} hint={TEAM_ROLES.find((r) => r.id === role)?.hint}>
        <RoleSelect id={`${id}-role`} value={role} onChange={setRole} />
      </Field>
    </>
  );
}

const persons = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** Adds each address as a member with `role`; says how it went. Those it could not add come back. */
async function addAll(act: (action: string, body: Record<string, unknown>) => Promise<unknown>, folder: string, emails: string[], role: string) {
  const out = await each(emails, (member) => act("add_team_member", { folder, member, role }), errorMessage);
  if (!out.failed.length) toast(tr("Added {value} as {role}", { value: persons(emails.length), role }));
  else {
    const [first] = out.failed;
    toast(`${out.done.length ? `Added ${persons(out.done.length)}. ` : ""}${first.item}: ${first.reason}${out.failed.length > 1 ? ` (and ${out.failed.length - 1} more)` : ""}`, "error");
  }
  return out;
}

export function TeamDialog({ team, space, onClose }: { team: string; space: string; onClose: () => void }) {
  const qc = useQueryClient();
  const id = useId();
  const usage = useUsage();
  const t = usage.data?.teams.find((x) => x.id === team);
  const admin = !!usage.data?.admin;
  const people = usePeople().data?.users ?? [];
  const act = (action: string, body: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${space}/actions/${action}`, body);
  const shares = useQuery({ queryKey: ["drive", "shares", team], queryFn: () => act("list_shares", { item: team }) as Promise<Shares> });
  const members = shares.data?.team?.members ?? [];
  const [text, setText] = useState("");
  const [role, setRole] = useState("Viewer");
  const [limit, setLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["drive"] });
  const quota = limit ?? gigabytesOf(t?.quota_bytes ?? null);
  const wanted = megabytesOf(quota);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const { emails } = addresses(text);
    if (!emails.length) return;
    void run("add", async () => {
      const out = await addAll(act, team, emails, role);
      setText(out.failed.map((f) => f.item).join(", "));
    });
  };
  const nameOf = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.full_name;

  return (
    <Dialog open wide title={t ? tr("Team folder “{name}”", { name: t.name }) : tr("Team folder")} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{tr("Done")}</Button>}>
      {usage.isPending ? (
        <Spinner label={tr("Loading the team folder")} />
      ) : !t ? (
        <EmptyState title={tr("This team folder is not here any more")} />
      ) : (
        <div className="share-grid">
          <section aria-labelledby={`${id}-members`}>
            <h3 id={`${id}-members`} className="share-head">
              {tr("Members ({length})", { length: members.length })}
            </h3>
            {shares.isPending ? (
              <Spinner label={tr("Loading members")} />
            ) : shares.error ? (
              <p className="muted">{isolate(errorMessage(shares.error))}</p>
            ) : !members.length ? (
              <p className="faint">{tr("Nobody belongs to it yet.")}</p>
            ) : (
              <ul className="share-list">
                {members.map((m) => (
                  <li key={m.member} className="share-row">
                    <span className="share-who">
                      <strong>{nameOf(m.member) || m.member}</strong>
                      {nameOf(m.member) && <span className="faint">{isolate(m.member)}</span>}
                    </span>
                    <RoleSelect value={m.role} label={tr("Role of {value}", { value: nameOf(m.member) || m.member })} disabled={busy === `role-${m.member}`} onChange={(next) => void run(`role-${m.member}`, () => act("add_team_member", { folder: team, member: m.member, role: next }))} />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={tr("Remove {value}", { value: nameOf(m.member) || m.member })}
                      loading={busy === `gone-${m.member}`}
                      onClick={async () => {
                        if (await confirmDialog({ title: tr("Remove {value}?", { value: nameOf(m.member) || m.member }), message: tr("They lose access to everything in the team folder."), confirmLabel: tr("Remove"), danger: true }))
                          void run(`gone-${m.member}`, () => act("remove_team_member", { folder: team, member: m.member }));
                      }}
                    >
                      {tr("Remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby={`${id}-space`}>
            <h3 id={`${id}-space`} className="share-head">
              {tr("Space")}
            </h3>
            <p>
              {isolate(spaceLabel({ used: t.used_bytes, quota: t.quota_bytes }))}
              {leftLabel({ used: t.used_bytes, quota: t.quota_bytes }) && <span className="faint"> · {isolate(leftLabel({ used: t.used_bytes, quota: t.quota_bytes }) ?? "")}</span>}
            </p>
            <Meter space={{ used: t.used_bytes, quota: t.quota_bytes }} label={tr("Space used by {name}", { name: t.name })} />
            {admin ? (
              <form
                className="share-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (wanted !== null) void run("quota", async () => { await act("set_team_quota", { folder: team, quota_mb: wanted }); setLimit(null); toast(wanted ? tr("The space limit is changed") : tr("The team folder has no space limit")); });
                }}
              >
                <Field label={tr("Space limit (GB)")} htmlFor={`${id}-quota`} error={wanted === null ? "Use a number of gigabytes, or leave it empty" : undefined} hint={tr("Empty for no limit. Versions and the trash count")}>
                  <input id={`${id}-quota`} className="input" inputMode="decimal" value={quota} onChange={(e) => setLimit(e.target.value)} />
                </Field>
                <Button type="submit" loading={busy === "quota"} disabled={wanted === null || limit === null}>
                  {tr("Save limit")}
                </Button>
              </form>
            ) : (
              <p className="faint">{tr("A Drive administrator sets how much space it may use.")}</p>
            )}

            <h3 className="share-head">{tr("Add people")}</h3>
            <form className="share-add" onSubmit={add} aria-label={tr("Add people")}>
              <AddPeople id={id} role={role} setRole={setRole} text={text} setText={setText} />
              <Button type="submit" variant="primary" loading={busy === "add"} disabled={!addresses(text).emails.length}>
                {tr("Add")}
              </Button>
            </form>
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** A new team folder (Drive administrators): its name, how much space it may use, and who is in it. */
export function NewTeamDialog({ space, onClose, onMade }: { space: string; onClose: () => void; onMade: (folder: string) => void }) {
  const qc = useQueryClient();
  const id = useId();
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [text, setText] = useState("");
  const [role, setRole] = useState("Editor");
  const [busy, setBusy] = useState(false);
  const wanted = megabytesOf(limit);
  const typed = addresses(text);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || wanted === null || busy) return;
    setBusy(true);
    try {
      const made = (await api.post(`/api/v1/DriveSpace/${space}/actions/create_team_folder`, {
        name: name.trim(),
        quota_mb: limit.trim() ? wanted : undefined,
        members: typed.emails.map((member) => ({ member, role })),
      })) as { folder: { id: string } };
      await qc.invalidateQueries({ queryKey: ["drive"] });
      toast(tr("Team folder “{name}” made", { name: name.trim() }));
      onMade(made.folder.id);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={tr("New team folder")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr("Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || wanted === null} onClick={() => void submit()}>
            {tr("Make the team folder")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        <p className="muted">{tr("A shared place for a department, with its own space. Its members see everything in it.")}</p>
        <Field label={tr("Name")} htmlFor={`${id}-name`} required>
          <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus />
        </Field>
        <Field label={tr("Space limit (GB)")} htmlFor={`${id}-limit`} error={wanted === null ? "Use a number of gigabytes, or leave it empty" : undefined} hint={tr("Empty for the workspace's usual limit; 0 for no limit")}>
          <input id={`${id}-limit`} className="input" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
        <AddPeople id={id} role={role} setRole={setRole} text={text} setText={setText} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
