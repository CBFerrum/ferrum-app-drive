// A file in the online editor (Collabora Online or ONLYOFFICE, over WOPI): `/drive/edit/:file` posts
// the editor's token to its frame, shows who else is in the file (from the editor's own messages),
// turns its Share, version-history and Close buttons into Drive's own panels, and says whether
// there are unsaved changes.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, bootstrap, download, errorMessage, initials, t, isolate } from "@ferrum/client";
import { Badge, Button, ReaderSkeleton, StatePanel, toast } from "@ferrum/kit";
import { DetailsPanel } from "./Details";
import { type Shareable, allows } from "./files";
import { contentUrl } from "./files";
import { useQuery } from "@tanstack/react-query";
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
  // Silent for too long (the editor is down): said, with a way to try again.
  const [silent, setSilent] = useState(false);
  const [again, setAgain] = useState(0);
  const space = useSpace();
  const info = useQuery({ queryKey: ["drive", "item", file], queryFn: ({ signal }) => api.get<{ permission: string }>("/api/app/drive/item_info", { item: file }, signal), enabled: !!file });
  // Ferrum's look goes to the editor, and follows when it changes while the file is open.
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  const leave = () => ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate("/drive"));

  useEffect(() => {
    let live = true;
    setLaunch(null);
    setError(null);
    setSilent(false);
    api.post<Launch>(`/api/app/drive/editor/${file}`, undefined, { query: { theme, lang: bootstrap()?.locale.language } }).then(
      (l) => live && setLaunch(l),
      // Never an address of the editor server: only the words.
      (e: unknown) => live && setError(errorMessage(e).replace(/https?:\/\/\S+/g, "").trim()),
    );
    return () => {
      live = false;
    };
  }, [file, theme, again]);
  // An editor that says nothing for 30 seconds is not there (a frame that cannot connect shows nothing).
  useEffect(() => {
    if (!launch) return;
    const timer = setTimeout(() => setSilent(true), 30_000);
    const heard = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow) {
        clearTimeout(timer);
        setSilent(false);
      }
    };
    addEventListener("message", heard);
    return () => {
      clearTimeout(timer);
      removeEventListener("message", heard);
    };
  }, [launch]);
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

  const saveCopy = () => void download(contentUrl(file!), launch?.name ?? t("File")).catch((e: unknown) => toast(errorMessage(e), "error"));
  if (error) {
    return (
      <StatePanel
        kind="failed"
        title={t("This file cannot be opened online")}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setAgain((n) => n + 1)}>{t("Try again")}</Button>
            <Button onClick={saveCopy}>{t("Download")}</Button>
            <Button onClick={() => navigate(-1)}>{t("Back")}</Button>
          </div>
        }
      >
        {isolate(error)}
      </StatePanel>
    );
  }
  if (!launch || !file) return <ReaderSkeleton />;
  return (
    <div className="editor-page">
      <div className="editor-bar">
        <Button size="sm" icon="left" onClick={leave}>
          {t("Back")}
        </Button>
        <strong>{isolate(launch.name)}</strong>
        {launch.action === "view" && <Badge>{t("Read only")}</Badge>}
        {others ? (
          others.length > 0 && (
            <span className="editor-people" role="group" aria-label={t("Also in the file: {value}", { value: others.map((v) => v.name + (v.readOnly ? t(" (viewing)") : "")).join(", ") })}>
              {others.slice(0, 6).map((v) => (
                <span key={v.id} className="editor-person" style={{ background: v.color, color: inkOn(v.color) }} title={v.readOnly ? t("{name} (viewing)", { name: v.name }) : v.name} aria-hidden>
                  {isolate(initials(v.name))}
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
          present.length > 0 && <Badge tone="green">{isolate(presenceLabel(present))}</Badge>
        )}
        {others && elsewhere.length > 0 && <Badge tone="amber">{isolate(presenceLabel(elsewhere))} {t("in a browser editor")}</Badge>}
        {launch.action === "edit" && (
          <span className="faint" role="status">
            {modified === true ? t("Unsaved changes") : modified === false ? t("All changes saved") : t("Changes are saved as new versions in Drive.")}
          </span>
        )}
        <span className="editor-bar-end">
          {info.data && allows(info.data.permission, "Manage") && (
            <Button size="sm" icon="share" onClick={() => setSharing({ id: file, name: launch.name, kind: "file" })}>
              {t("Share")}
            </Button>
          )}
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
        {silent && (
          <StatePanel
            kind="offline"
            title={t("The office editor is not answering")}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" onClick={() => setAgain((n) => n + 1)}>
                  {t("Retry")}
                </Button>
                <Button onClick={saveCopy}>{t("Download")}</Button>
              </div>
            }
          >
            {t("Your file is safe in Drive.")}
          </StatePanel>
        )}
        <iframe ref={frame} name="office-editor" title={t("{name} in the editor", { name: launch.name })} className="editor-frame" hidden={silent} allow="clipboard-read; clipboard-write; fullscreen" />
        {panel && space.data && <DetailsPanel id={file} space={space.data.id} tab={panel} inEditor onClose={() => setPanel(null)} onShare={setSharing} />}
      </div>
      {sharing && space.data && <ShareDialog item={sharing} space={space.data.id} onClose={() => setSharing(null)} />}
    </div>
  );
}
