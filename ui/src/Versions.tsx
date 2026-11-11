// A file's versions: who made each and when, to download, restore as the newest, name, or keep for
// good; adding a new one; and what Drive does with old ones, said as it is (the newest few are
// kept, older ones are removed as new ones come, a version kept is never removed).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, Upload } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { api, download, errorMessage, formatDateTime, t as tr, isolate } from "@ferrum/client";
import { Badge, Button, Dialog, Field, ListSkeleton, LoadFailed, confirmDialog, toast } from "@ferrum/kit";
import { type ItemInfo, allows, isLiveDoc, sizeLabel } from "./files";
import { useUsage } from "./useDrive";
import { addVersion } from "./versionUpload";

export interface Version {
  id: string;
  version: number;
  size: number;
  author?: string | null;
  comment?: string | null;
  created_at?: string;
  /** Kept for good, and its name: only a Drive that can do so says (an older server leaves them out). */
  kept?: boolean;
  label?: string | null;
}

type Act = (action: string, params: Record<string, unknown>) => Promise<unknown>;

/** What Drive does with old versions, in words. `max` is how many it keeps (unknown on an older server); `count` how many this file has. */
export function retention(max: number | undefined, count: number, oldestKept: boolean): string {
  if (!max) return tr("Drive removes the oldest versions of a file as new ones are added, to save space. A version you keep is never removed.");
  if (count >= max && !oldestKept) return tr("Drive keeps the newest {max} versions of a file. This file has {count}: the oldest one is removed when the next is added, unless you keep it.", { max, count });
  return tr("Drive keeps the newest {max} versions of a file ({count} here). Older ones are removed as new ones are added, unless you keep them.", { max, count });
}

/** Names a version and chooses whether it is kept for good. */
function KeepDialog({ version, onSave, onClose }: { version: Version; onSave: (label: string, kept: boolean) => Promise<void>; onClose: () => void }) {
  const field = useId();
  const [label, setLabel] = useState(version.label ?? "");
  const [kept, setKept] = useState(!!version.kept);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    await onSave(label.trim(), kept);
    setBusy(false);
    onClose();
  };
  return (
    <Dialog
      open
      title={tr("Version {version}", { version: version.version })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr("Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {tr("Save")}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        <Field label={tr("Name")} htmlFor={field} hint={tr("Optional: something to find it by, such as “Sent to the auditors”")}>
          <input id={field} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="drive-check" checked={kept} onChange={(e) => setKept(e.target.checked)} />
          <span>
            <strong>{tr("Keep forever")}</strong>
            <span className="faint block">{tr("It is never removed to make room for newer versions. It still uses your storage.")}</span>
          </span>
        </label>
      </form>
    </Dialog>
  );
}

export function Versions({ item, act, onRestored }: { item: ItemInfo; act: Act; onRestored: () => unknown }) {
  const qc = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const usage = useUsage();
  const [naming, setNaming] = useState<Version | null>(null);
  const q = useQuery({
    queryKey: ["drive", "versions", item.id],
    queryFn: ({ signal }) => api.get<{ versions: Version[] }>("/api/app/drive/list_versions", { file: item.id }, signal).then((r) => r.versions),
  });
  // A live document's editors hold its content: an old version comes back as a document of its own.
  const live = isLiveDoc(item.name);
  const canEdit = allows(item.permission, "Edit");
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["drive"] });
    await onRestored();
  };
  const restore = async (v: Version) => {
    const message = live ? tr("A copy of it is made beside this document, which stays as it is.") : tr("It becomes the newest version; the others stay in the history.");
    if (!(await confirmDialog({ title: tr("Restore version {version}?", { version: v.version }), message, confirmLabel: tr("Restore") }))) return;
    try {
      const made = await act("restore_version", { file: item.id, version: v.version });
      toast(live ? tr("Version {version} is now “{value}”", { version: v.version, value: (made as { name?: string }).name ?? tr("a copy") }) : tr("Version {version} restored", { version: v.version }));
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const keep = async (v: Version, label: string, kept: boolean) => {
    try {
      await act("keep_version", { file: item.id, version: v.version, label, kept });
      toast(kept ? tr("Version {version} is kept forever", { version: v.version }) : tr("Version {version} is saved", { version: v.version }));
      await qc.invalidateQueries({ queryKey: ["drive", "versions", item.id] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  if (q.isLoading) return <ListSkeleton rows={3} />;
  if (q.error) return <LoadFailed error={q.error} onRetry={() => void q.refetch()} />;
  const list = q.data ?? [];
  // A Drive that can keep versions says whether each is.
  const keeps = list.some((v) => v.kept !== undefined);
  const oldest = list[list.length - 1];
  return (
    <div className="drive-versions-box">
      {canEdit && !live && (
        <>
          <Button size="sm" onClick={() => picker.current?.click()}>
            <Upload aria-hidden size={14} /> {tr("Upload a new version…")}
          </Button>
          <input
            ref={picker}
            type="file"
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const content = e.target.files?.[0];
              e.target.value = "";
              if (content) void addVersion(item, content, { most: usage.data?.limits.max_upload_bytes, carries: usage.data?.limits.request_bytes }).then(async (done) => {
                if (done) await refresh();
              });
            }}
          />
        </>
      )}
      <ul className="drive-versions">
        {list.map((v) => (
          <li key={v.id}>
            <div>
              <strong>{tr("Version {version}", { version: v.version })}</strong>
              {v.version === item.version && <Badge tone="green">{tr("Current")}</Badge>}
              {v.kept && (
                <Badge tone="blue" title={tr("Kept forever")}>
                  <Pin aria-hidden size={11} className="inline" /> {tr("Kept")}
                </Badge>
              )}
              {v.label && <div className="drive-version-label">{isolate(v.label)}</div>}
              <div className="faint">
                {v.created_at ? formatDateTime(v.created_at) : ""}
                {v.author ? ` · ${v.author}` : ""} · {isolate(sizeLabel(v.size))}
              </div>
              {v.comment && <div className="muted">{isolate(v.comment)}</div>}
            </div>
            <div className="drive-version-actions">
              <Button
                size="sm"
                variant="ghost"
                icon="download"
                aria-label={live ? tr("Download version {version} as a web page", { version: v.version }) : tr("Download version {version}", { version: v.version })}
                onClick={() =>
                  void (
                    live
                      ? download(`/api/app/drive/files/${item.id}/content`, item.name.replace(/\.fdoc$/i, ".html"), { version: v.version, format: "html" })
                      : download(`/api/app/drive/files/${item.id}/content`, item.name, { version: v.version })
                  ).catch((e) => toast(errorMessage(e), "error"))
                }
              />
              {keeps && canEdit && (
                <Button size="sm" variant="ghost" aria-label={tr("Name or keep version {version}", { version: v.version })} onClick={() => setNaming(v)}>
                  {v.kept || v.label ? tr("Edit") : tr("Name or keep")}
                </Button>
              )}
              {v.version !== item.version && canEdit && (
                <Button size="sm" onClick={() => void restore(v)}>
                  {tr("Restore")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!live && <p className="faint drive-retention">{retention(usage.data?.limits.max_versions, list.length, !!oldest?.kept)}</p>}
      {naming && <KeepDialog version={naming} onSave={(label, kept) => keep(naming, label, kept)} onClose={() => setNaming(null)} />}
    </div>
  );
}
