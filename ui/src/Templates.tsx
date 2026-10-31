// Templates for new Office files (the drive app's `list_templates`, `POST /new?template=`,
// `save_as_template` and `delete_template`): Drive's own, and the workspace's, which Drive
// administrators save from files people made.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, errorMessage } from "@ferrum/client";
import { Button, Dialog, Field, Spinner, Tabs, confirmDialog, toast } from "@ferrum/kit";
import { Button as UiButton } from "@ferrum/kit/primitives";
import { Trash2 } from "lucide-react";
import { FileGlyph } from "./Drive";

export interface Template {
  id: string;
  kind: string;
  title: string;
  category: string | null;
  description: string | null;
  builtin: boolean;
}

/** The templates, and whether the person manages the workspace's (Drive administrators do). */
export function useTemplates() {
  return useQuery({
    queryKey: ["drive-templates"],
    queryFn: ({ signal }) => api.get<{ templates: Template[]; manage: boolean }>("/api/app/drive/list_templates", undefined, signal),
    staleTime: 60_000,
  });
}

/** Files a template can be saved from. */
export const templatable = (name: string) => /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(name);

const GROUPS = [
  { id: "all", label: "All", kinds: ["docx", "xlsx", "pptx", "odt", "ods", "odp"] },
  { id: "doc", label: "Documents", kinds: ["docx", "odt"] },
  { id: "sheet", label: "Spreadsheets", kinds: ["xlsx", "ods"] },
  { id: "slides", label: "Presentations", kinds: ["pptx", "odp"] },
];

/** The gallery: picking a template makes a file from it in `folder`. `only` keeps to one group
 *  (Sheets, Slides). Drive administrators delete the workspace's templates here. */
export function TemplateDialog({
  folder,
  space,
  only,
  onMade,
  onClose,
}: {
  folder: string;
  space: string;
  only?: "sheet" | "slides";
  onMade: (file: { id: string; name: string; size: number | null }) => void;
  onClose: () => void;
}) {
  const tabsId = useId();
  const qc = useQueryClient();
  const list = useTemplates();
  const [group, setGroup] = useState<string>(only ?? "all");
  const [busy, setBusy] = useState<string | null>(null);
  const kinds = GROUPS.find((g) => g.id === group)?.kinds ?? GROUPS[0]!.kinds;
  const shown = (list.data?.templates ?? []).filter((t) => kinds.includes(t.kind));
  const use = async (t: Template) => {
    setBusy(t.id);
    try {
      onMade(await api.post<{ id: string; name: string; size: number | null }>("/api/app/drive/new", undefined, { query: { template: t.id, folder } }));
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(null);
    }
  };
  const remove = async (t: Template) => {
    if (!(await confirmDialog({ title: `Delete the template “${t.title}”?`, message: "Nobody can start from it any more. Files made from it stay as they are.", confirmLabel: "Delete template", danger: true })))
      return;
    try {
      await api.post(`/api/v1/DriveSpace/${space}/actions/delete_template`, { template: t.id });
      toast(`The template “${t.title}” is deleted`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    await qc.invalidateQueries({ queryKey: ["drive-templates"] });
  };
  const section = (title: string, items: Template[]) =>
    items.length > 0 && (
      <section className="drive-templates-group" aria-label={title}>
        <h3 className="drive-templates-head">{title}</h3>
        <ul className="drive-pick drive-templates">
          {items.map((t) => (
            <li key={t.id} className="drive-template">
              <button type="button" className="drive-pick-item" disabled={!!busy} aria-busy={busy === t.id} onClick={() => void use(t)}>
                <FileGlyph kind="file" name={`template.${t.kind}`} size={24} />
                <span className="drive-pick-name">{t.title}</span>
                <span className="faint drive-template-about">{[t.category, t.description].filter(Boolean).join(" · ") || t.kind.toUpperCase()}</span>
              </button>
              {!t.builtin && list.data?.manage && (
                <UiButton variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Delete the template ${t.title}`} onClick={() => void remove(t)}>
                  <Trash2 />
                </UiButton>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <Dialog open wide title="New from a template" onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
      {!only && <Tabs id={tabsId} tabs={GROUPS.map(({ id, label }) => ({ id, label }))} value={group} onChange={setGroup} />}
      {list.isPending ? (
        <Spinner label="Loading templates" />
      ) : list.error ? (
        <p className="muted">{errorMessage(list.error)}</p>
      ) : (
        <div className="drive-templates-body">
          {section("Your workspace", shown.filter((t) => !t.builtin))}
          {section("From Drive", shown.filter((t) => t.builtin))}
          {!shown.length && <p className="muted">No templates of this kind yet.</p>}
          {list.data?.manage && <p className="faint">To add your own, choose Save as a template in a file's menu.</p>}
        </div>
      )}
    </Dialog>
  );
}

/** Saves an Office file as one of the workspace's templates (Drive administrators). */
export function SaveTemplateDialog({ file, space, onClose }: { file: { id: string; name: string }; space: string; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [title, setTitle] = useState(file.name.replace(/\.[^.]+$/, ""));
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/DriveSpace/${space}/actions/save_as_template`, {
        file: file.id,
        title: name,
        category: category.trim() || undefined,
        description: description.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["drive-templates"] });
      toast(`“${name}” is a template: everyone can start from it with New`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Save “${file.name}” as a template`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void submit()}>
            Save template
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        <p className="muted">Everyone in the workspace can start new files from it. It keeps a copy of the file as it is now: later changes to the file leave the template as it was.</p>
        <Field label="Title" htmlFor={`${id}-title`} required>
          <input id={`${id}-title`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} autoFocus />
        </Field>
        <Field label="Category" htmlFor={`${id}-category`} hint="Groups templates, such as Finance or Meetings">
          <input id={`${id}-category`} className="input" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Description" htmlFor={`${id}-description`} hint="What it is for, in a line">
          <input id={`${id}-description`} className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
