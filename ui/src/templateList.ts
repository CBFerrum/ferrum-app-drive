// Templates for new Office files, as the page needs to know them before it opens the gallery: which
// there are, and whether the person manages the workspace's own.

import { useQuery } from "@tanstack/react-query";
import { api } from "@ferrum/client";

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
