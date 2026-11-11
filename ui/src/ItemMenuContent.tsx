// What the item menu holds: everything that can be done with an item. Loaded after the page has drawn
// (and at once when a menu is pressed), so the page does not carry the icons and rules of a menu nobody has opened.

import { ArchiveRestore, Copy, Download, Eye, ExternalLink, FolderInput, Info, LayoutTemplate, Pencil, Share2, Star, StarOff, Trash2, Upload } from "lucide-react";
import { t as tr, isolate } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@ferrum/kit/primitives";
import { openChoice } from "./editors";
import { type EditorChoice, type Item, allows, isLiveDoc, shared, shownName } from "./files";
import type { RowActions } from "./ItemMenu";
import { joinable, type Present } from "./presence";
import { templatable } from "./templateList";

export default function ItemMenuContent({ it, trash, open, others, here, templates, actions }: { it: Item; trash: boolean; open: EditorChoice | undefined; others: EditorChoice[]; here: Present[]; templates: boolean; actions: RowActions }) {
  const name = shownName(it.name);
  const editing = here.filter((p) => p.mode === "edit");
  return (
    <>
      {trash ? (
        <>
          <DropdownMenuItem onSelect={() => actions.restore(it)}>
            <ArchiveRestore /> {tr("Restore")}
          </DropdownMenuItem>
          {allows(it.permission, "Manage") && (
            <DropdownMenuItem variant="destructive" onSelect={() => actions.destroy(it)}>
              <Trash2 /> {tr("Delete forever")}
            </DropdownMenuItem>
          )}
        </>
      ) : (
        <>
          {it.kind === "file" && (
            <DropdownMenuItem onSelect={() => actions.open(it)}>
              <Eye /> {tr("Preview")}
            </DropdownMenuItem>
          )}
          {open && (
            <DropdownMenuItem onSelect={() => openChoice(open, actions.navigate)}>
              <ExternalLink /> {open.key === "live" || open.key === "view" || !allows(it.permission, "Edit") || editing.length > 0 ? tr("Open in the editor") : tr("Edit online")}
            </DropdownMenuItem>
          )}
          {others.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ExternalLink /> {tr("Open with")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-52">
                {others.map((c) => (
                  <DropdownMenuItem key={c.key} onSelect={() => (c.unavailable ? toast(tr("{label} cannot open {name}: {unavailable}", { label: c.label, name, unavailable: c.unavailable }), "error") : openChoice(c, actions.navigate))}>
                    <span className="grid">
                      {isolate(c.label)}
                      {c.unavailable && <span className="text-xs text-muted-foreground">{isolate(c.unavailable)}</span>}
                      {!c.unavailable && editing.length > 0 && (
                        <span className="text-xs text-muted-foreground">{shared(c.key) && joinable(here) ? tr("Join {value}", { value: editing.map((p) => p.name).join(", ") }) : tr("Read only while others edit")}</span>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.details(it)}>
            <Info /> {tr("Details")}
          </DropdownMenuItem>
          {allows(it.permission, "Manage") && (
            <DropdownMenuItem onSelect={() => actions.share(it)}>
              <Share2 /> {tr("Share")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => actions.star(it)}>
            {it.starred ? <StarOff /> : <Star />} {it.starred ? tr("Remove star") : tr("Star")}
          </DropdownMenuItem>
          {allows(it.permission, "Edit") && (
            <DropdownMenuItem onSelect={() => actions.rename(it)}>
              <Pencil /> {tr("Rename")}
            </DropdownMenuItem>
          )}
          {allows(it.permission, "Edit") && (
            <DropdownMenuItem onSelect={() => actions.move(it, false)}>
              <FolderInput /> {tr("Move to…")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => actions.move(it, true)}>
            <Copy /> {tr("Copy to…")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.download(it)}>
            <Download /> {it.kind === "folder" ? tr("Download as a zip file") : tr("Download")}
          </DropdownMenuItem>
          {it.kind === "file" && allows(it.permission, "Edit") && !isLiveDoc(it.name) && (
            <DropdownMenuItem onSelect={() => actions.newVersion(it)}>
              <Upload /> {tr("Upload a new version…")}
            </DropdownMenuItem>
          )}
          {it.kind === "file" && templates && templatable(it.name) && (
            <DropdownMenuItem onSelect={() => actions.saveTemplate(it)}>
              <LayoutTemplate /> {tr("Save as a template")}
            </DropdownMenuItem>
          )}
          {allows(it.permission, "Edit") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => actions.trash(it)}>
                <Trash2 /> {tr("Move to trash")}
              </DropdownMenuItem>
            </>
          )}
        </>
      )}
    </>
  );
}
