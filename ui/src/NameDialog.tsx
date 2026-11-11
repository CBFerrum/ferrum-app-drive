// Asks for a name (a new folder).

import { type FormEvent, useId, useState } from "react";
import { t as tr } from "@ferrum/client";
import { Button, Dialog, Field } from "@ferrum/kit";

/** Asks for a name. */
export function NameDialog({ title, label, initial, done, onClose }: { title: string; label: string; initial: string; done: (name: string) => Promise<unknown>; onClose: () => void }) {
  const fieldId = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await done(name.trim());
    setBusy(false);
    onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr("Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {tr("Save")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label={label} htmlFor={fieldId}>
          <input id={fieldId} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={255} />
        </Field>
      </form>
    </Dialog>
  );
}
