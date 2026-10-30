// Who has Drive's files open now (Drive's /presence endpoints; Ferrum docs/plan/collaboration.md):
// the editor pages report every 30 seconds that their person is viewing or editing a file, and
// lists and details ask who has their files open.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@ferrum/client";

export interface Present {
  name: string;
  mode: "view" | "edit";
  /** "browser" when they edit in a browser editor, which is one person's at a time. */
  editor?: "browser";
}

/** Whether others are editing where one can join them: not in a browser editor (C2). */
export const joinable = (people: Present[]) => people.some((p) => p.mode === "edit") && !people.some((p) => p.editor === "browser");

const EVERY = 30_000;
/** At most this many files per question: their ids go in the address. */
const MAX_FILES = 150;

/** Reports this page's person on `file` while the page is open (and leaving when it closes);
 *  answers who else is there. `mode` null reports nothing. */
export function usePresence(file: string | undefined, mode: "view" | "edit" | null): Present[] {
  const [others, setOthers] = useState<Present[]>([]);
  useEffect(() => {
    if (!file || !mode) return;
    let alive = true;
    const beat = () =>
      api.post<{ present: Present[] }>(`/api/app/drive/presence/${file}`, undefined, { query: { mode } }).then(
        (r) => alive && setOthers(r.present),
        () => undefined,
      );
    void beat();
    const timer = setInterval(beat, EVERY);
    const gone = () => {
      void fetch(`/api/app/drive/presence/${file}?mode=gone`, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {});
    };
    addEventListener("pagehide", gone);
    return () => {
      alive = false;
      clearInterval(timer);
      removeEventListener("pagehide", gone);
      gone();
    };
  }, [file, mode]);
  return others;
}

/** Who has each of these files open now, refreshed every 30 seconds. */
export function useFilesPresence(files: string[]) {
  const key = files.slice(0, MAX_FILES).sort().join(",");
  return useQuery({
    queryKey: ["drive", "presence", key],
    queryFn: ({ signal }) => api.get<{ present: Record<string, Present[]> }>("/api/app/drive/presence", { files: key }, signal).then((r) => r.present),
    enabled: key.length > 0,
    refetchInterval: EVERY,
  });
}

/** "Ana is editing", "Ana and Ben are viewing", "Ana and 2 others are here". */
export function presenceLabel(people: Present[]): string {
  if (!people.length) return "";
  const editing = people.some((p) => p.mode === "edit");
  const doing = people.every((p) => p.mode === "edit") ? "editing" : people.every((p) => p.mode === "view") ? "viewing" : "here";
  const verb = people.length === 1 ? "is" : "are";
  const who = people.length === 1 ? people[0].name : people.length === 2 ? `${people[0].name} and ${people[1].name}` : `${people[0].name} and ${people.length - 1} others`;
  return `${who} ${verb} ${editing && doing === "here" ? "here, editing" : doing}`;
}
