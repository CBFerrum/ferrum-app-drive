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
import { DrivePage } from "./Drive";
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

/** A page loaded when it is opened: the home page is the only one every visit needs. */
const later = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => () => load().then((m) => ({ Component: m[name] }));
const pages = () => import("./Pages");

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
          { path: "edit/:file", lazy: later(() => import("./Edit"), "EditPage") },
          { path: "edit/:file/:editor", lazy: later(() => import("./BrowserEdit"), "BrowserEditPage") },
          { path: "view/:file", lazy: later(pages, "ViewPage") },
          { path: "item/:id", lazy: later(pages, "ItemPage") },
          { path: "s/:tenant/:link", lazy: later(() => import("./SharedLink"), "SharedLinkPage") },
          { path: "_intent/pick", lazy: later(pages, "PickPage") },
          { path: "_intent/preview", lazy: later(pages, "PreviewPage") },
          { path: "_intent/share", lazy: later(pages, "ShareIntentPage") },
          { path: "_panel/details", lazy: later(pages, "DetailsPanelPage") },
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
