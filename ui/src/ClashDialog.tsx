// A file whose name is taken in the folder: keep both, add it as a new version of the one there, or
// skip it. Asked once for each such file, or once for all of them. Nothing is sent until every
// question is answered; cancelling sends nothing.

import { useState } from "react";
import { t as tr } from "@ferrum/client";
import { Button, Dialog } from "@ferrum/kit";
import { type Choice, decide } from "./clash";

export function ClashDialog({ names, folder, onDone, onCancel }: { names: string[]; folder: string; onDone: (choices: Map<string, Choice>) => void; onCancel: () => void }) {
  const [at, setAt] = useState(0);
  const [all, setAll] = useState(false);
  const [answers, setAnswers] = useState<{ name?: string; choice: Choice; all: boolean }[]>([]);
  const name = names[at];
  const answer = (choice: Choice) => {
    const next = [...answers, { name, choice, all: all && names.length > 1 }];
    if (all || at + 1 >= names.length) return onDone(decide(names, next));
    setAnswers(next);
    setAt(at + 1);
  };
  return (
    <Dialog
      open
      title={tr("“{name}” is already in “{folder}”", { name, folder })}
      description={names.length > 1 ? tr("File {at} of {n} with a name that is taken", { at: at + 1, n: names.length }) : undefined}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{tr("Cancel the upload")}</Button>
          <span className="spacer" />
          <Button onClick={() => answer("skip")}>{tr("Skip")}</Button>
          <Button onClick={() => answer("both")}>{tr("Keep both")}</Button>
          <Button variant="primary" data-autofocus onClick={() => answer("replace")}>
            {tr("Replace")}
          </Button>
        </>
      }
    >
      <ul className="drive-clash">
        <li>
          <strong>{tr("Keep both")}</strong> {tr("Yours is saved beside it, as a copy with a number.")}
        </li>
        <li>
          <strong>{tr("Replace")}</strong> {tr("Yours becomes the newest version of the file in Drive. Its sharing and links stay, and what is there now stays in its version history.")}
        </li>
        <li>
          <strong>{tr("Skip")}</strong> {tr("Yours is not uploaded.")}
        </li>
      </ul>
      {names.length > 1 && (
        <label className="drive-clash-all">
          <input type="checkbox" className="drive-check" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {tr("Do this for all {n} files whose names are taken", { n: names.length })}
        </label>
      )}
    </Dialog>
  );
}
