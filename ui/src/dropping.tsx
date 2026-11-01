// Places an item or a file can be dropped on (a folder in the list, a folder in the path above it,
// a place in the rail): what the page knows about the drag, and the handlers each place wears.

import { createContext, type DragEvent, useContext } from "react";
import { type Carried, bringsFiles, bringsItems, canDropOn, copying } from "./drag";
import { type Entry, entriesOf } from "./dropped";
import { allows } from "./files";

/** A folder that takes drops. A place whose level is not known (the rail's) leaves it to the server. */
export interface DropTarget {
  id: string;
  name: string;
  permission?: string;
}

export interface DropApi {
  /** Drive's own items being dragged now, from this page. */
  carrying: Carried[] | null;
  /** The folder a drag is over. */
  over: string | null;
  setOver: (id: string | null) => void;
  /** Items dropped on a folder: moved, or copied with a key held. */
  items: (items: Carried[], to: DropTarget, copy: boolean) => void;
  /** Files and folders dropped on a folder, to upload into it. */
  files: (entries: Entry[], to: DropTarget) => void;
}

export const DropContext = createContext<DropApi | null>(null);

/** What dropping this drag here would do, or none. */
function effectOf(api: DropApi, to: DropTarget, e: DragEvent): "move" | "copy" | null {
  const types = e.dataTransfer.types;
  if (api.carrying && bringsItems(types)) {
    const copy = copying(e);
    return canDropOn(api.carrying, to, copy) ? (copy ? "copy" : "move") : null;
  }
  return bringsFiles(types) && (to.permission === undefined || allows(to.permission, "Edit")) ? "copy" : null;
}

/** The handlers of a place that takes drops, and whether a drag is over it now. Drive's own items
 *  and files from the computer are both taken. */
export function useDropTarget(to: DropTarget | null) {
  const api = useContext(DropContext);
  if (!api || !to) return { props: {}, over: false };
  const over = api.over === to.id;
  return {
    over,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (effectOf(api, to, e)) {
          e.preventDefault();
          api.setOver(to.id);
        }
      },
      onDragOver: (e: DragEvent) => {
        const effect = effectOf(api, to, e);
        if (!effect) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = effect;
        if (api.over !== to.id) api.setOver(to.id);
      },
      onDragLeave: (e: DragEvent) => {
        if (api.over === to.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) api.setOver(null);
      },
      onDrop: (e: DragEvent) => {
        const effect = effectOf(api, to, e);
        if (!effect) return;
        e.preventDefault();
        e.stopPropagation();
        api.setOver(null);
        if (api.carrying && bringsItems(e.dataTransfer.types)) api.items(api.carrying, to, effect === "copy");
        else api.files(entriesOf(e.dataTransfer), to);
      },
    },
  };
}
