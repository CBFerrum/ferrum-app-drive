// What can be done with the items that are chosen, all at once: the bar appears above the list
// while any are chosen. An action the person may not do to every one of them is not offered.

import { ArchiveRestore, Copy, Download, FolderInput, Share2, Trash2 } from "lucide-react";
import { SelectionToolbar } from "@ferrum/kit";
import { Button } from "@ferrum/kit/primitives";
import { type Item, allows } from "./files";
import { items as count } from "./bulk";
import { t } from "@ferrum/client";

export interface BulkActions {
  move: (copy: boolean) => void;
  share: () => void;
  download: () => void;
  trash: () => void;
  restore: () => void;
  destroy: () => void;
  clear: () => void;
}

export function BulkBar({ chosen, trash, actions }: { chosen: Item[]; trash: boolean; actions: BulkActions }) {
  const every = (needed: string) => chosen.every((i) => allows(i.permission, needed));
  const folders = chosen.some((i) => i.kind === "folder");
  return (
    <SelectionToolbar label={t("Actions for {value}", { value: count(chosen.length) })} count={chosen.length} onClear={actions.clear}>
      {trash ? (
        <>
          <Button size="sm" variant="outline" onClick={actions.restore}>
            <ArchiveRestore /> {t("Restore")}
          </Button>
          {every("Manage") && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={actions.destroy}>
              <Trash2 /> {t("Delete forever")}
            </Button>
          )}
        </>
      ) : (
        <>
          {every("Edit") && (
            <Button size="sm" variant="outline" onClick={() => actions.move(false)}>
              <FolderInput /> {t("Move to…")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => actions.move(true)}>
            <Copy /> {t("Copy to…")}
          </Button>
          {every("Manage") && (
            <Button size="sm" variant="outline" onClick={actions.share}>
              <Share2 /> {t("Share")}
            </Button>
          )}
          <Button size="sm" variant="outline" title={folders || chosen.length > 1 ? t("Downloads as one zip file") : undefined} onClick={actions.download}>
            <Download /> {t("Download")}
          </Button>
          {every("Edit") && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={actions.trash}>
              <Trash2 /> {t("Move to trash")}
            </Button>
          )}
        </>
      )}
    </SelectionToolbar>
  );
}
