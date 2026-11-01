// Dialogs and panels that are loaded when they are opened, not with the page: the page starts
// sooner, and a person who never shares anything never downloads the sharing screens.

import { lazy, type ReactNode, Suspense } from "react";
import { Spinner } from "@ferrum/kit";

export const ShareDialog = lazy(() => import("./Share").then((m) => ({ default: m.ShareDialog })));
export const BulkShareDialog = lazy(() => import("./BulkShare").then((m) => ({ default: m.BulkShareDialog })));
export const MoveDialog = lazy(() => import("./MoveDialog").then((m) => ({ default: m.MoveDialog })));
export const TeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.TeamDialog })));
export const NewTeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.NewTeamDialog })));
export const ShortcutsDialog = lazy(() => import("./KeysDialog").then((m) => ({ default: m.ShortcutsDialog })));
export const TemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.TemplateDialog })));
export const SaveTemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.SaveTemplateDialog })));
export const DetailsPanel = lazy(() => import("./Details").then((m) => ({ default: m.DetailsPanel })));

/** Waits for a dialog's code; nothing shows meanwhile (a dialog opens as soon as it has arrived). */
export const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;

/** Waits for the details panel's code. */
export const LaterPanel = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <aside className="drive-details" aria-label="Details">
        <Spinner label="Loading details" />
      </aside>
    }
  >
    {children}
  </Suspense>
);
