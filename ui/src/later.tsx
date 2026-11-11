// Dialogs and panels that are loaded when they are opened, not with the page: the page starts
// sooner, and a person who never shares anything never downloads the sharing screens.

import { lazy, type ReactNode, Suspense } from "react";
import { FormSkeleton, ReaderSkeleton } from "@ferrum/kit";
import { t } from "@ferrum/client";

export const ShareDialog = lazy(() => import("./Share").then((m) => ({ default: m.ShareDialog })));
export const BulkShareDialog = lazy(() => import("./BulkShare").then((m) => ({ default: m.BulkShareDialog })));
export const MoveDialog = lazy(() => import("./MoveDialog").then((m) => ({ default: m.MoveDialog })));
export const TeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.TeamDialog })));
export const NewTeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.NewTeamDialog })));
export const ShortcutsDialog = lazy(() => import("./KeysDialog").then((m) => ({ default: m.ShortcutsDialog })));
export const TemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.TemplateDialog })));
export const SaveTemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.SaveTemplateDialog })));
export const DetailsPanel = lazy(() => import("./Details").then((m) => ({ default: m.DetailsPanel })));

/** Waits for a dialog's code; a dialog-shaped placeholder shows meanwhile (the dialog replaces it as soon as it has arrived). */
export const Later = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 p-4">
        <div className="w-full max-w-md rounded-xl border bg-card p-4 shadow-lg">
          <FormSkeleton fields={2} />
        </div>
      </div>
    }
  >
    {children}
  </Suspense>
);

/** Waits for the details panel's code. */
export const LaterPanel = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <aside className="drive-details" aria-label={t("Details")}>
        <ReaderSkeleton paragraphs={1} />
      </aside>
    }
  >
    {children}
  </Suspense>
);
