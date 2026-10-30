// Drive's own interface (Ferrum docs/plan/apps-ui.md §13), the head of the Workspace family:
// files at /drive/, and Sheets, Slides and PDF (Drive's files of one kind) at their own routes;
// the editors, the viewer, the shared-link page anyone with a link opens (/drive/s/…), and what
// Drive does for other apps: the pick, preview and share intents and the details panel.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, RouterProvider, useRouteError } from "react-router";
import { isPublicPage, routeBase, shell } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, Toaster } from "@ferrum/kit";
import { DrivePage, EditPage } from "./Drive";
import { DetailsPanelPage, ItemPage, PickPage, PreviewPage, ShareIntentPage, ViewPage } from "./Pages";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

/** A route's first segment as the bootstrap gives it (`drive`). Inside Drive, pages link to
 *  `/drive/…` directly. ponytail: an operator's remapped route covers these four entries only;
 *  the rest follow when routes can be remapped (docs/plan/apps-ui.md §10.1). */
const at = (route: string) => routeBase(route).replace(/^\/+|\/+$/g, "");

function Frame() {
  useEffect(() => shell().ready(), []);
  // Intent dialogs and side panels are frames of their own, with no margins.
  const framed = window.top !== window || isPublicPage();
  return (
    <main id="main" className={framed ? undefined : "drive-app"}>
      <Outlet />
    </main>
  );
}

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/drive">Go to Drive</Link>
    </EmptyState>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Frame />,
    errorElement: <RouteError />,
    // A first page that loads its code later shows nothing meanwhile (the bar is there already).
    hydrateFallbackElement: <span />,
    children: [
      {
        path: at("drive"),
        children: [
          { index: true, element: <DrivePage /> },
          { path: "edit/:file", element: <EditPage /> },
          { path: "edit/:file/:editor", lazy: () => import("./BrowserEdit").then((m) => ({ Component: m.BrowserEditPage })) },
          { path: "view/:file", element: <ViewPage /> },
          { path: "item/:id", element: <ItemPage /> },
          { path: "s/:tenant/:link", lazy: () => import("./SharedLink").then((m) => ({ Component: m.SharedLinkPage })) },
          { path: "_intent/pick", element: <PickPage /> },
          { path: "_intent/preview", element: <PreviewPage /> },
          { path: "_intent/share", element: <ShareIntentPage /> },
          { path: "_panel/details", element: <DetailsPanelPage /> },
          { path: ":folder", element: <DrivePage /> },
        ],
      },
      { path: at("sheets"), element: <DrivePage kind="Spreadsheet" /> },
      { path: at("slides"), element: <DrivePage kind="Presentation" /> },
      { path: at("pdf"), element: <DrivePage kind="PDF" /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);
