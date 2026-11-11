// Renaming where the name is: the name becomes a field with the part before the extension chosen.
// Enter asks the server, Escape leaves it; the new name shows once the server has it, and if it
// refuses, its reason is said right under the field and the field stays.

import { useEffect, useId, useRef, useState } from "react";
import { t as tr, isolate } from "@ferrum/client";
import { Spinner } from "@ferrum/kit";

export function RenameField({ initial, folder, onDone, onCancel }: { initial: string; folder: boolean; onDone: (name: string) => Promise<string | null>; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const noteId = useId();
  const settled = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = folder ? -1 : initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, folder]);
  const submit = async () => {
    const next = name.trim();
    if (busy || settled.current) return;
    if (!next || next === initial) return onCancel();
    setBusy(true);
    const refused = await onDone(next);
    setBusy(false);
    if (refused) {
      setWhy(refused);
      input.current?.focus();
    } else settled.current = true;
  };
  return (
    <span className="drive-rename" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className="input"
        value={name}
        disabled={busy}
        maxLength={255}
        aria-label={tr("New name")}
        aria-invalid={!!why || undefined}
        aria-describedby={why ? noteId : undefined}
        onChange={(e) => (setName(e.target.value), setWhy(null))}
        onKeyDown={(e) => {
          // The page's own keys (Delete, letters) stay out of a field.
          e.stopPropagation();
          if (e.key === "Enter") (e.preventDefault(), void submit());
          else if (e.key === "Escape") (e.preventDefault(), onCancel());
        }}
        onBlur={() => (why ? onCancel() : void submit())}
      />
      {busy && <Spinner small label={tr("Renaming")} />}
      {why && (
        <span id={noteId} role="alert" className="drive-rename-why">
          {isolate(why)}
        </span>
      )}
    </span>
  );
}
