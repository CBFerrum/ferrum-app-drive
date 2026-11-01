// The keys Drive answers to, in a dialog that `?` opens.

import { Fragment } from "react";
import { Button, Dialog } from "@ferrum/kit";
import { Kbd } from "@ferrum/kit/primitives";
import { SHORTCUTS, keyName } from "./shortcuts";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="muted">They work in the list, when no field has the focus. Delete asks before it moves anything to the trash.</p>
      <div className="drive-keys">
        {SHORTCUTS.map((g) => (
          <section key={g.group} aria-label={g.group}>
            <h3 className="share-head">{g.group}</h3>
            <dl>
              {g.keys.map((s) => (
                <div key={s.does}>
                  <dt>
                    {s.keys.map((alternative, i) => (
                      <Fragment key={alternative}>
                        {i > 0 && <span className="faint"> or </span>}
                        {alternative.split("+").map((key, j) => (
                          <Fragment key={key}>
                            {j > 0 && <span className="faint"> + </span>}
                            <Kbd>{keyName(key, mac)}</Kbd>
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </dt>
                  <dd>{s.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
