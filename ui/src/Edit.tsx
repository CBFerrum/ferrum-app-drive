// A file in the online editor (Collabora Online or ONLYOFFICE, over WOPI): `/drive/edit/:file` posts
// the editor's token to its frame, shows who else is in the file (from the editor's own messages),
// turns its Share, version-history and Close buttons into Drive's own panels, and says whether
// there are unsaved changes.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, errorMessage, initials, t } from "@ferrum/client";
import { Badge, Button, EmptyState, Spinner } from "@ferrum/kit";
import { DetailsPanel } from "./Details";
import type { Shareable } from "./files";
import { presenceLabel, usePresence } from "./presence";
import { ShareDialog } from "./Share";
import { useSpace } from "./useDrive";
import { type EditorView, applyViews, hostMessage, inkOn, othersOf, parseMessage } from "./wopi";

interface Launch {
  url: string;
  access_token: string;
  access_token_ttl: number;
  name: string;
  action: "edit" | "view";
}

/** `/drive/edit/:file`: the file in the editor server; the page posts the token to the editor's frame. */
export function EditPage() {
  const { file } = useParams();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the editor tells: who is in the file (null until it says), unsaved changes.
  const [views, setViews] = useState<EditorView[] | null>(null);
  const [modified, setModified] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<"comments" | "versions" | null>(null);
  const [sharing, setSharing] = useState<Shareable | null>(null);
  const space = useSpace();
  const leave = () => ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate("/drive"));

  useEffect(() => {
    let live = true;
    api.post<Launch>(`/api/app/drive/editor/${file}`).then(
      (l) => live && setLaunch(l),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [file]);
  useEffect(() => {
    if (launch) form.current?.submit();
  }, [launch]);
  // The editor's messages (Ferrum docs/plan/collaboration.md, C2): only from its own frame and origin.
  useEffect(() => {
    if (!launch || !file) return;
    const origin = new URL(launch.url, location.href).origin;
    const post = (id: string) => frame.current?.contentWindow?.postMessage(hostMessage(id), origin);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const m = parseMessage(e.data);
      if (!m) return;
      switch (m.id) {
        case "App_LoadingStatus": {
          const status = (m.values as { Status?: string } | null)?.Status;
          if (status === "Frame_Ready") post("Host_PostmessageReady");
          if (status === "Document_Loaded") post("Get_Views");
          break;
        }
        case "View_Added":
        case "View_Removed":
        case "Get_Views_Resp":
        case "Views_List":
          setViews((v) => applyViews(v, m));
          break;
        case "Doc_ModifiedStatus":
          setModified((m.values as { Modified?: unknown } | null)?.Modified === true);
          break;
        // Its Share and version history buttons open Drive's own.
        case "UI_Share":
        case "UI_Sharing":
          setSharing({ id: file, name: launch.name, kind: "file" });
          break;
        case "UI_FileVersions":
          setPanel("versions");
          break;
        case "UI_Close":
          leave();
          break;
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [launch, file]);
  // Drive's lists show who has the file open; the editor names who is in it, when it says.
  const present = usePresence(file, launch ? (launch.action === "edit" ? "edit" : "view") : null);
  const others = views ? othersOf(views) : null;
  // Whoever edits it in a browser editor holds it, and the editor here only shows it meanwhile.
  const elsewhere = present.filter((p) => p.editor === "browser");

  if (error) {
    return (
      <EmptyState title={t("This file cannot be opened online")} icon="file">
        <p className="muted">{error}</p>
        <Button onClick={() => navigate(-1)}>{t("Back")}</Button>
      </EmptyState>
    );
  }
  if (!launch || !file) return <Spinner label={t("Opening the editor")} />;
  return (
    <div className="editor-page">
      <div className="editor-bar">
        <Button size="sm" icon="left" onClick={leave}>
          {t("Back")}
        </Button>
        <strong>{launch.name}</strong>
        {launch.action === "view" && <Badge>{t("Read only")}</Badge>}
        {others ? (
          others.length > 0 && (
            <span className="editor-people" role="group" aria-label={`Also in the file: ${others.map((v) => v.name + (v.readOnly ? " (viewing)" : "")).join(", ")}`}>
              {others.slice(0, 6).map((v) => (
                <span key={v.id} className="editor-person" style={{ background: v.color, color: inkOn(v.color) }} title={v.readOnly ? `${v.name} (viewing)` : v.name} aria-hidden>
                  {initials(v.name)}
                </span>
              ))}
              {others.length > 6 && (
                <span className="editor-person editor-person-more" aria-hidden>
                  +{others.length - 6}
                </span>
              )}
            </span>
          )
        ) : (
          present.length > 0 && <Badge tone="green">{presenceLabel(present)}</Badge>
        )}
        {others && elsewhere.length > 0 && <Badge tone="amber">{presenceLabel(elsewhere)} {t("in a browser editor")}</Badge>}
        {launch.action === "edit" && (
          <span className="faint" role="status">
            {modified === true ? "Unsaved changes" : modified === false ? "All changes saved" : "Changes are saved as new versions in Drive."}
          </span>
        )}
        <span className="editor-bar-end">
          <Button size="sm" aria-pressed={!!panel} onClick={() => setPanel(panel ? null : "comments")}>
            {t("Comments and history")}
          </Button>
        </span>
      </div>
      <form ref={form} action={launch.url} method="post" target="office-editor" hidden>
        <input type="hidden" name="access_token" value={launch.access_token} />
        <input type="hidden" name="access_token_ttl" value={String(launch.access_token_ttl)} />
      </form>
      <div className={panel ? "editor-main editor-main-details" : "editor-main"}>
        <iframe ref={frame} name="office-editor" title={`${launch.name} in the editor`} className="editor-frame" allow="clipboard-read; clipboard-write; fullscreen" />
        {panel && space.data && <DetailsPanel id={file} space={space.data.id} tab={panel} inEditor onClose={() => setPanel(null)} onShare={setSharing} />}
      </div>
      {sharing && space.data && <ShareDialog item={sharing} space={space.data.id} onClose={() => setSharing(null)} />}
    </div>
  );
}
