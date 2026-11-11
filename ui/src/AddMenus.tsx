// The New and Upload menus. Loaded just after the page (the buttons are there meanwhile), so the page does
// not carry the menu machinery until a menu is wanted.

import { ChevronDown, FileUp, FolderPlus, FolderUp, LayoutTemplate, Plus, Upload } from "lucide-react";
import { isolate, t as tr } from "@ferrum/client";
import { Spinner } from "@ferrum/kit";
import { Button as UiButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { FileGlyph } from "./FileGlyph";
import { sizeLabel } from "./files";

export default function AddMenus({ kind, fresh, busy, limit, create, gallery, newFolder, files, folder }: { kind: boolean; fresh: readonly { kind: string; label: string }[]; busy: boolean; limit: number | null; create: (kind: string) => void; gallery: () => void; newFolder: () => void; files: () => void; folder: () => void }) {
  return (
    <>
      {kind ? (
        fresh.map((n) => (
          <span key={n.kind} className="contents">
            <UiButton size="sm" variant="outline" onClick={() => create(n.kind)}>
              <Plus /> {isolate(n.label)}
            </UiButton>
            <UiButton size="sm" variant="outline" onClick={() => gallery()}>
              <LayoutTemplate /> {tr("From a template")}
            </UiButton>
          </span>
        ))
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <UiButton size="sm" variant="outline" aria-label={tr("New document or folder")}>
              <Plus /> {tr("New")}
            </UiButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            {fresh.map((n) => (
              <DropdownMenuItem key={n.kind} onSelect={() => create(n.kind)}>
                <FileGlyph kind="file" name={`new.${n.kind}`} size={16} /> {isolate(n.label)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => gallery()}>
              <LayoutTemplate /> {tr("From a template…")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={newFolder}>
              <FolderPlus /> {tr("Folder")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <UiButton size="sm" disabled={busy}>
            {busy ? <Spinner small /> : <Upload />} {tr("Upload")} <ChevronDown />
          </UiButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onSelect={() => files()}>
            <FileUp /> {tr("Files…")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => folder()}>
            <FolderUp /> {tr("Folder…")}
          </DropdownMenuItem>
          {limit !== null && (
            <>
              <DropdownMenuSeparator />
              <p className="drive-menu-note">{tr("Up to {size} for each file", { size: sizeLabel(limit) })}</p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
