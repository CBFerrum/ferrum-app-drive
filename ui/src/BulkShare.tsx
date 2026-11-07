// Sharing several items with one person at once: who, as what, and until when. Each item is shared
// on its own, so one that cannot be (the person has no right to share it) does not stop the rest.

import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage, todayIso, t } from "@ferrum/client";
import { Button, Dialog, Field, toast } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";
import { each, items as count, told } from "./bulk";
import { type Item, shownName } from "./files";
import { ROLES, roleLabel } from "./roles";

export function BulkShareDialog({ items, space, onClose, onDone }: { items: Item[]; space: string; onClose: () => void; onDone: (failed: Item[]) => void }) {
  const qc = useQueryClient();
  const id = useId();
  const people = usePeople().data?.users ?? [];
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState("View");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const who = email.trim().toLowerCase();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!who || busy) return;
    setBusy(true);
    const out = await each(items, (i) => api.post(`/api/v1/DriveSpace/${space}/actions/share`, { item: i.id, email: who, permission, expires_at: until || undefined }), errorMessage);
    await qc.invalidateQueries({ queryKey: ["drive"] });
    const said = told({ done: "Shared", doing: "share" }, out, `with ${who} as ${roleLabel(permission)}`);
    toast(said.message, said.error ? "error" : "success");
    onDone(out.failed.map((f) => f.item));
    onClose();
  };
  return (
    <Dialog
      open
      title={`Share ${count(items.length)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!who} onClick={() => void submit()}>
            {t("Share")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        <p className="muted share-names">{items.slice(0, 4).map((i) => shownName(i.name)).join(", ")}{items.length > 4 ? ` and ${items.length - 4} more` : ""}</p>
        <Field label={t("Person")} htmlFor={`${id}-email`} hint={t("Someone outside the workspace gets a link by email, as a Viewer")}>
          <input id={`${id}-email`} className="input" type="email" list={`${id}-people`} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <datalist id={`${id}-people`}>
            {people.map((p) => (
              <option key={p.id} value={p.email}>
                {p.full_name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label={t("Role")} htmlFor={`${id}-role`}>
          <select id={`${id}-role`} className="input" value={permission} onChange={(e) => setPermission(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.permission} value={r.permission}>
                {r.label}: {r.hint}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Until")} htmlFor={`${id}-until`} hint={t("Optional")}>
          <input id={`${id}-until`} className="input" type="date" min={todayIso()} value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
