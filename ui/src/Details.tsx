// A Drive item's details beside its folder (Ferrum docs/plan/collaboration.md, C1): who has it
// open now, comments with @mentions, versions to download or restore, and what happened to it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api, download, errorMessage, formatDateTime, relativeTime, t as tr, isolate } from "@ferrum/client";
import { Badge, Button, Spinner, TabPanel, Tabs, confirmDialog, toast } from "@ferrum/kit";
import { Composer, usePeople } from "@ferrum/records";
import { EditorLink, useEditors } from "./editors";
import { type ItemInfo, type Shareable, allows, defaultEditor, editorsFor, isLiveDoc, shared, shownName, sizeLabel } from "./files";
import { joinable, presenceLabel, useFilesPresence } from "./presence";
import { roleLabel } from "./roles";

export type { ItemInfo };
interface Version {
  id: string;
  version: number;
  size: number;
  author?: string | null;
  comment?: string | null;
  created_at?: string;
}
interface DriveComment {
  id: string;
  author?: string | null;
  body: string;
  created_at: string;
  mine: boolean;
  /** A reply: the comment starting its thread. */
  reply_to?: string | null;
  /** On a live document's text: the words, as they read. */
  quote?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
}
interface Activity {
  id: string;
  at: string;
  action: string;
  actor?: string | null;
  name?: string | null;
}

/** `tab`: the tab to show first. `inEditor`: shown beside the file's own editor (no "Join them"). */
export function DetailsPanel({
  id,
  space,
  onClose,
  onShare,
  tab: first = "comments",
  inEditor = false,
}: {
  id: string;
  space: string;
  onClose: () => void;
  onShare: (item: Shareable) => void;
  tab?: string;
  inEditor?: boolean;
}) {
  const qc = useQueryClient();
  const tabsId = useId();
  const [tab, setTab] = useState(first);
  useEffect(() => setTab(first), [first]);
  const editors = useEditors();
  const act = (action: string, params: Record<string, unknown>) => api.post(`/api/v1/DriveSpace/${space}/actions/${action}`, params);
  const info = useQuery({ queryKey: ["drive", "item", id], queryFn: ({ signal }) => api.get<ItemInfo>("/api/app/drive/item_info", { item: id }, signal) });
  const item = info.data;
  const isFile = item?.kind === "file";
  const present = useFilesPresence(isFile ? [id] : []).data?.[id] ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["drive"] });

  if (info.error) {
    return (
      <aside className="drive-details" aria-label={tr("Details")}>
        <div className="drive-details-head">
          <strong>{tr("No access")}</strong>
          <Button size="sm" variant="ghost" icon="x" aria-label={tr("Close details")} onClick={onClose} />
        </div>
        <RequestAccess id={id} act={act} onGranted={() => qc.invalidateQueries({ queryKey: ["drive", "item", id] })} />
      </aside>
    );
  }
  if (!item) {
    return (
      <aside className="drive-details" aria-label={tr("Details")}>
        <Spinner label={tr("Loading details")} />
      </aside>
    );
  }
  const tabs = [
    ...(isFile ? [{ id: "comments", label: tr("Comments") }] : []),
    ...(isFile ? [{ id: "versions", label: tr("Versions") }] : []),
    { id: "activity", label: tr("Activity") },
  ];
  const shown = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  // Others editing in an editor people share: join them there (C2).
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
  const open = isFile && !inEditor ? defaultEditor(editorsFor({ id: item.id, name: item.name, size: item.size ?? null }, editors), narrow) : undefined;
  const join = open && shared(open.key) && joinable(present) ? open : undefined;
  return (
    <aside className="drive-details" aria-label={tr("Details of {value}", { value: shownName(item.name) })}>
      <div className="drive-details-head">
        <strong className="drive-details-name">{isolate(shownName(item.name))}</strong>
        <Button size="sm" variant="ghost" icon="x" aria-label={tr("Close details")} onClick={onClose} />
      </div>
      <dl className="drive-facts">
        {item.path && (
          <>
            <dt>{tr("Where")}</dt>
            <dd>{isolate(item.path)}</dd>
          </>
        )}
        <dt>{tr("Owner")}</dt>
        <dd>{item.owner ?? tr("Team folder")}</dd>
        {isFile && (
          <>
            <dt>{tr("Size")}</dt>
            <dd>
              {isolate(sizeLabel(item.size ?? null))} {tr("· version {version}", { version: item.version ?? "" })}
            </dd>
          </>
        )}
        <dt>{tr("Modified")}</dt>
        <dd>
          {isolate(formatDateTime(item.modified_at))}
          {item.modified_by ? tr(" by {modified_by}", { modified_by: item.modified_by }) : ""}
        </dd>
        <dt>{tr("Your access")}</dt>
        <dd>{isolate(roleLabel(item.permission))}</dd>
      </dl>
      {present.length > 0 && (
        <p className="drive-present" role="status">
          <Badge tone="green">{tr("Now")}</Badge> {isolate(presenceLabel(present))}
          {join && (
            <EditorLink className="btn btn-primary btn-sm" choice={join}>
              {tr("Join them")}
            </EditorLink>
          )}
        </p>
      )}
      {item.locked_by && <p className="faint">{tr("Checked out by {locked_by}.", { locked_by: item.locked_by })}</p>}
      {allows(item.permission, "Manage") && (
        <Button size="sm" onClick={() => onShare(item)}>
          {tr("Share")}
        </Button>
      )}
      <Tabs id={tabsId} tabs={tabs} value={shown} onChange={setTab} />
      <TabPanel id={tabsId} tab={shown}>
        {shown === "comments" && <Comments item={item} act={act} />}
        {shown === "versions" && <Versions item={item} act={act} onRestored={refresh} />}
        {shown === "activity" && <ActivityList id={item.id} />}
      </TabPanel>
    </aside>
  );
}

type Act = (action: string, params: Record<string, unknown>) => Promise<unknown>;

function Comments({ item, act }: { item: ItemInfo; act: Act }) {
  const qc = useQueryClient();
  const people = usePeople().data?.users ?? [];
  const q = useQuery({
    queryKey: ["drive", "comments", item.id],
    queryFn: ({ signal }) => api.get<{ comments: DriveComment[] }>("/api/app/drive/list_comments", { file: item.id }, signal).then((r) => r.comments),
  });
  const name = (email?: string | null) => people.find((p) => p.email === email)?.full_name || email || tr("Someone");
  const post = async (body: string, mentionIds: string[]) => {
    try {
      const mentions = people.filter((p) => mentionIds.includes(p.id)).map((p) => p.email);
      await act("add_comment", { file: item.id, body, mentions });
      await qc.invalidateQueries({ queryKey: ["drive", "comments", item.id] });
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      return false;
    }
  };
  const remove = async (c: DriveComment) => {
    if (!(await confirmDialog({ title: tr("Delete this comment?"), confirmLabel: tr("Delete"), danger: true }))) return;
    try {
      await act("delete_comment", { comment: c.id });
      await qc.invalidateQueries({ queryKey: ["drive", "comments", item.id] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  if (q.isLoading) return <Spinner label={tr("Loading comments")} />;
  if (q.error) return <p className="muted">{isolate(errorMessage(q.error))}</p>;
  return (
    <div className="drive-comments">
      {!q.data?.length && <p className="faint">{tr("No comments yet.")}</p>}
      <ul className="drive-comment-list">
        {/* Threads: replies under the comment they answer; comments on a document's text quote it. */}
        {q.data
          ?.filter((c) => !c.reply_to)
          .map((c) => (
            <li key={c.id} className={`drive-comment${c.resolved_at ? " is-resolved" : ""}`}>
              {c.quote && <blockquote className="drive-comment-quote">{isolate(c.quote)}</blockquote>}
              <div className="drive-comment-head">
                <strong>{isolate(name(c.author))}</strong> <span className="faint">{isolate(relativeTime(c.created_at))}</span>
                {c.resolved_at && <span className="faint">{tr("· resolved by")} {isolate(name(c.resolved_by))}</span>}
                {(c.mine || allows(item.permission, "Manage")) && (
                  <Button size="sm" variant="ghost" aria-label={tr("Delete comment")} onClick={() => void remove(c)}>
                    {tr("Delete")}
                  </Button>
                )}
              </div>
              <p className="comment-text">{isolate(c.body)}</p>
              {q.data
                .filter((r) => r.reply_to === c.id)
                .map((r) => (
                  <div key={r.id} className="drive-comment-reply">
                    <div className="drive-comment-head">
                      <strong>{isolate(name(r.author))}</strong> <span className="faint">{isolate(relativeTime(r.created_at))}</span>
                      {(r.mine || allows(item.permission, "Manage")) && (
                        <Button size="sm" variant="ghost" aria-label={tr("Delete reply")} onClick={() => void remove(r)}>
                          {tr("Delete")}
                        </Button>
                      )}
                    </div>
                    <p className="comment-text">{isolate(r.body)}</p>
                  </div>
                ))}
            </li>
          ))}
      </ul>
      {allows(item.permission, "Comment") ? <Composer people={people} onPost={post} /> : <p className="faint">{tr("You can view this file but not comment on it.")}</p>}
    </div>
  );
}

function Versions({ item, act, onRestored }: { item: ItemInfo; act: Act; onRestored: () => unknown }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["drive", "versions", item.id],
    queryFn: ({ signal }) => api.get<{ versions: Version[] }>("/api/app/drive/list_versions", { file: item.id }, signal).then((r) => r.versions),
  });
  // A live document's editors hold its content: an old version comes back as a document of its own.
  const live = isLiveDoc(item.name);
  const restore = async (v: Version) => {
    const message = live ? "A copy of it is made beside this document, which stays as it is." : "It becomes the newest version; the others stay in the history.";
    if (!(await confirmDialog({ title: tr("Restore version {version}?", { version: v.version }), message, confirmLabel: tr("Restore") }))) return;
    try {
      const made = await act("restore_version", { file: item.id, version: v.version });
      toast(live ? tr("Version {version} is now “{value}”", { version: v.version, value: (made as { name?: string }).name ?? "a copy" }) : tr("Version {version} restored", { version: v.version }));
      await qc.invalidateQueries({ queryKey: ["drive"] });
      await onRestored();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  if (q.isLoading) return <Spinner label={tr("Loading versions")} />;
  if (q.error) return <p className="muted">{isolate(errorMessage(q.error))}</p>;
  return (
    <ul className="drive-versions">
      {q.data?.map((v) => (
        <li key={v.id}>
          <div>
            <strong>{tr("Version {version}", { version: v.version })}</strong>
            {v.version === item.version && <Badge tone="green">{tr("Current")}</Badge>}
            <div className="faint">
              {v.created_at ? formatDateTime(v.created_at) : ""}
              {v.author ? ` · ${v.author}` : ""} · {isolate(sizeLabel(v.size))}
            </div>
            {v.comment && <div className="muted">{isolate(v.comment)}</div>}
          </div>
          <div className="row" style={{ gap: 4 }}>
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
            {v.version !== item.version && allows(item.permission, "Edit") && (
              <Button size="sm" onClick={() => void restore(v)}>
                {tr("Restore")}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["drive", "activity", id],
    queryFn: ({ signal }) => api.get<{ activity: Activity[] }>("/api/app/drive/activity", { item: id, limit: 50 }, signal).then((r) => r.activity),
  });
  if (q.isLoading) return <Spinner label={tr("Loading activity")} />;
  if (q.error) return <p className="muted">{isolate(errorMessage(q.error))}</p>;
  if (!q.data?.length) return <p className="faint">{tr("Nothing yet.")}</p>;
  return (
    <ul className="drive-activity">
      {q.data.map((a) => (
        <li key={a.id}>
          <strong>{a.actor ?? tr("Drive")}</strong> {isolate(a.action.toLowerCase())}
          {a.name && <span className="muted"> “{isolate(a.name)}”</span>}
          <div className="faint">{isolate(relativeTime(a.at))}</div>
        </li>
      ))}
    </ul>
  );
}

/** An item this person cannot see (a link, a removed share): they may ask its owner for access.
 *  Drive answers the same whether or not it exists. */
function RequestAccess({ id, act, onGranted }: { id: string; act: Act; onGranted: () => unknown }) {
  const fieldId = useId();
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const ask = async () => {
    setState("busy");
    try {
      const answer = (await act("request_access", { item: id, message: message.trim() || undefined })) as { has_access?: boolean };
      if (answer.has_access) {
        await onGranted();
        return;
      }
      setState("sent");
    } catch (e) {
      toast(errorMessage(e), "error");
      setState("idle");
    }
  };
  if (state === "sent") return <p role="status">{tr("Your request was sent. You will be told when it is shared with you.")}</p>;
  return (
    <div className="drive-request">
      <p>{tr("You don't have access to this item, or it no longer exists. You can ask its owner to share it with you.")}</p>
      <label htmlFor={fieldId} className="field-label">
        {tr("Message (optional)")}
      </label>
      <textarea id={fieldId} className="textarea" rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
      <Button variant="primary" loading={state === "busy"} onClick={() => void ask()}>
        {tr("Request access")}
      </Button>
    </div>
  );
}
