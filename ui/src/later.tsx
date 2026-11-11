// Dialogs and panels that are loaded when they are opened, not with the page: the page starts
// sooner, and a person who never shares anything never downloads the sharing screens.

import { lazy, type ReactNode, Suspense } from "react";
import { FormSkeleton, ListSkeleton, ReaderSkeleton } from "@ferrum/kit";
import { t } from "@ferrum/client";
import { Skeleton } from "@ferrum/kit/primitives";

export const ShareDialog = lazy(() => import("./Share").then((m) => ({ default: m.ShareDialog })));
export const BulkShareDialog = lazy(() => import("./BulkShare").then((m) => ({ default: m.BulkShareDialog })));
export const MoveDialog = lazy(() => import("./MoveDialog").then((m) => ({ default: m.MoveDialog })));
export const TeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.TeamDialog })));
export const NewTeamDialog = lazy(() => import("./Teams").then((m) => ({ default: m.NewTeamDialog })));
export const ShortcutsDialog = lazy(() => import("./KeysDialog").then((m) => ({ default: m.ShortcutsDialog })));
export const TemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.TemplateDialog })));
export const SaveTemplateDialog = lazy(() => import("./TemplateDialogs").then((m) => ({ default: m.SaveTemplateDialog })));
export const BulkBar = lazy(() => import("./BulkBar").then((m) => ({ default: m.BulkBar })));
export const NameDialog = lazy(() => import("./NameDialog").then((m) => ({ default: m.NameDialog })));
export const ClashDialog = lazy(() => import("./ClashDialog").then((m) => ({ default: m.ClashDialog })));
export const Preview = lazy(() => import("./Preview").then((m) => ({ default: m.Preview })));
export const FileGrid = lazy(() => import("./FileGrid").then((m) => ({ default: m.FileGrid })));
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

/** Waits for the grid's code, with a grid-shaped placeholder. */
export const LaterGrid = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="drive-grid" role="status" aria-label={t("Loading…")}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="drive-card drive-card-skeleton" aria-hidden="true" />
        ))}
      </div>
    }
  >
    {children}
  </Suspense>
);

/** Waits for the preview's code: the overlay is there at once, shaped like what it will show. */
export const LaterPreview = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="drive-preview drive-preview-loading" role="status" aria-label={t("Opening the preview")}>
        <ListSkeleton rows={4} />
      </div>
    }
  >
    {children}
  </Suspense>
);

/** Waits for the bar of chosen items: a bar-shaped placeholder holds its place. */
export const LaterBulk = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="flex items-center gap-2 border-b border-border bg-primary-soft px-4 py-2" role="status" aria-label={t("Loading…")}>
        <Skeleton className="h-8 w-28 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-24 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-24 motion-reduce:animate-none" />
      </div>
    }
  >
    {children}
  </Suspense>
);
