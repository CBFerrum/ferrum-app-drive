// What Drive is sending by itself: a large file in parts, a new version. Real progress (bytes the server has
// acknowledged), Stop, and Retry that goes on from what was sent. Shown while there is something to show.

import { RotateCw, Square, X } from "lucide-react";
import { t as tr, isolate } from "@ferrum/client";
import { Progress } from "@ferrum/kit";
import { Button as UiButton } from "@ferrum/kit/primitives";
import { sizeLabel } from "./files";
import { type Row, dismiss, retry, stop } from "./largeUploads";

const state = (r: Row) =>
  r.state === "done"
    ? tr("Done")
    : r.state === "stopped"
      ? r.discarded
        ? tr("Stopped. What was sent has been discarded.")
        : tr("Stopped. What was sent is kept for a day, so sending it again goes on from there.")
      : r.state === "failed"
        ? (r.error ?? tr("Failed"))
        : (r.note ?? tr("{sent} of {size}", { sent: sizeLabel(r.sent), size: sizeLabel(r.size) }));

export default function UploadsPanel({ rows }: { rows: Row[] }) {
  return (
    <section className="drive-uploads" aria-label={tr("Uploads Drive is sending")}>
      <h2>{tr("Uploads")}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.id} data-state={r.state}>
            <div className="drive-uploads-head">
              <span className="drive-uploads-name" title={r.name}>
                {isolate(r.name)}
              </span>
              {r.state === "going" && (
                <UiButton size="xs" variant="outline" aria-label={tr("Stop uploading {name}", { name: r.name })} onClick={() => stop(r.id)}>
                  <Square /> {tr("Stop")}
                </UiButton>
              )}
              {(r.state === "failed" || r.state === "stopped") && (
                <UiButton size="xs" variant="outline" aria-label={tr("Retry {name}", { name: r.name })} onClick={() => retry(r.id)}>
                  <RotateCw /> {tr("Retry")}
                </UiButton>
              )}
              {r.state !== "going" && (
                <UiButton size="icon-sm" variant="ghost" aria-label={tr("Dismiss {name}", { name: r.name })} onClick={() => dismiss(r.id)}>
                  <X />
                </UiButton>
              )}
            </div>
            {r.state === "going" && <Progress value={r.sent} max={r.size || 1} label={tr("{name} sent", { name: r.name })} />}
            <small className={r.state === "failed" ? "drive-uploads-err" : undefined} role={r.state === "failed" ? "alert" : "status"}>
              {isolate(state(r))} {r.state === "going" && r.size > 0 && <span className="faint">{Math.floor((r.sent / r.size) * 100).toLocaleString()}%</span>}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
