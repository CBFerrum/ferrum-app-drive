// The one menu of everything that can be done with an item, in the list's row and on the grid's card.
// The button is here; what the menu holds (ItemMenuContent.tsx) loads after the page has drawn.

import { MoreHorizontal } from "lucide-react";
import { Suspense, lazy } from "react";
import { t as tr } from "@ferrum/client";
import { Button as UiButton, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, Skeleton } from "@ferrum/kit/primitives";
import type { Carried } from "./drag";
import type { EditorChoice, Item } from "./files";
import { shownName } from "./files";
import type { Present } from "./presence";

const content = () => import("./ItemMenuContent");
const ItemMenuContent = lazy(content);
/** Asks for the menu's code before it is needed: once the page is quiet, and when a button is reached. */
const warm = () => void content();
if (typeof window !== "undefined") (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500)))(warm);

/** What a row or a card can ask the page to do. They are the same functions for every row. */
export interface RowActions {
  open: (it: Item) => void;
  /** The address that shows a file in the preview. */
  previewTo: (it: Item) => { search: string };
  details: (it: Item) => void;
  share: (it: Item) => void;
  star: (it: Item) => void;
  /** Starts renaming where the name is. */
  rename: (it: Item) => void;
  /** Asks for the new name; the answer is why not, or null when it is done. */
  renameTo: (it: Item, name: string) => Promise<string | null>;
  stopRenaming: () => void;
  move: (it: Item, copy: boolean) => void;
  download: (it: Item) => void;
  newVersion: (it: Item) => void;
  trash: (it: Item) => void;
  restore: (it: Item) => void;
  destroy: (it: Item) => void;
  saveTemplate: (it: Item) => void;
  navigate: (to: string) => void;
  /** Chooses or unchooses a row (with Shift: the stretch from the last chosen). */
  choose: (id: string, shift: boolean) => void;
  chooseAll: (on: boolean) => void;
  /** A row is picked up: the items the drag carries. */
  dragStart: (row: Item) => Carried[];
  dragEnd: () => void;
}

export function ItemMenu({
  it,
  trash,
  open,
  others,
  here,
  templates,
  actions,
}: {
  it: Item;
  trash: boolean;
  /** The editor "Open" uses, and the others that can take the file. */
  open: EditorChoice | undefined;
  others: EditorChoice[];
  here: Present[];
  templates: boolean;
  actions: RowActions;
}) {
  const name = shownName(it.name);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("More for {name}", { name })} className="text-muted-foreground" onPointerEnter={warm} onFocus={warm}>
          <MoreHorizontal />
        </UiButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <Suspense
          fallback={
            <div className="grid gap-2 p-2" role="status" aria-label={tr("Loading…")}>
              <Skeleton className="h-6 w-40 motion-reduce:animate-none" />
              <Skeleton className="h-6 w-32 motion-reduce:animate-none" />
              <Skeleton className="h-6 w-36 motion-reduce:animate-none" />
            </div>
          }
        >
          <ItemMenuContent it={it} trash={trash} open={open} others={others} here={here} templates={templates} actions={actions} />
        </Suspense>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
