// The editors that open Drive's files: which apps and editor servers this workspace has, and the
// link or move into one (an editor inside Drive, or another app's page such as Docs').

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, shell } from "@ferrum/client";
import type { BrowserEditor, EditorChoice } from "./files";

/** The apps the person may use (the bar's launcher): whether Docs is one of them. */
export function useApps() {
  return useQuery({
    queryKey: ["shell", "apps"],
    queryFn: () => shell().apps(),
    staleTime: 300_000,
  });
}
export const useDocs = () => !!useApps().data?.some((a) => a.app === "docs");

/** The editors this server runs (`GET /api/app/drive/editors`) and the browser editors on offer. */
export function useEditors() {
  const kinds = useQuery({
    queryKey: ["drive", "editors"],
    queryFn: ({ signal }) => api.get<{ online: boolean; browser: boolean }>("/api/app/drive/editors", undefined, signal),
    staleTime: 300_000,
  });
  const offered = useQuery({
    queryKey: ["drive", "editors", "browser"],
    queryFn: ({ signal }) => api.get<{ items: BrowserEditor[] }>("/api/meta/contributions/drive.editor", undefined, signal).then((r) => r.items),
    enabled: !!kinds.data?.browser,
    staleTime: 300_000,
  });
  return {
    loading: kinds.isPending || (!!kinds.data?.browser && offered.isPending),
    online: !!kinds.data?.online,
    browser: kinds.data?.browser ? (offered.data ?? []) : [],
  };
}

/** A link to an editor: inside Drive, or another app's page. */
export function EditorLink({ choice, className, children, ...rest }: { choice: EditorChoice; className?: string; children: React.ReactNode; "aria-label"?: string }) {
  if (choice.external)
    return (
      <a className={className} href={choice.to} draggable={false} {...rest}>
        {children}
      </a>
    );
  return (
    <Link className={className} to={choice.to} draggable={false} {...rest}>
      {children}
    </Link>
  );
}

/** Goes to an editor (inside Drive, or another app). */
export function openChoice(choice: EditorChoice, navigate: (to: string) => void) {
  if (choice.external) shell().navigate(choice.to);
  else navigate(choice.to);
}
