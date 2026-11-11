// Adding a file as the newest version of another, from the file list's menu or the version list: it
// says first what will happen (the file keeps its name, whatever the new file is called), checks the
// size against what one upload carries (a version has no upload in parts yet), and hands the file to
// the shell, whose tray shows it going.

import { errorMessage, t } from "@ferrum/client";
import { confirmDialog, toast } from "@ferrum/kit";
import { shownName, sizeLabel } from "./files";

export interface Limits {
  /** The most one file may be, if known. */
  most?: number | null;
  /** The most one upload request carries, if known. */
  carries?: number | null;
}

/** Why a file cannot go up as a version, or null. */
export function tooBig(content: { name: string; size: number }, limits: Limits): string | null {
  if (limits.carries && content.size > limits.carries)
    return t("“{name}” is {value} and one upload carries at most {value2}. Drive cannot add a larger file as a version yet.", { name: content.name, value: sizeLabel(content.size), value2: sizeLabel(limits.carries) });
  if (limits.most && content.size > limits.most) return t("“{name}” is {value} and the most Drive takes is {most}", { name: content.name, value: sizeLabel(content.size), most: sizeLabel(limits.most) });
  return null;
}

/** What the confirmation says: the same name or not, the file keeps its own. */
export function versionMessage(file: { name: string }, content: { name: string }): string {
  const same = content.name.trim().toLowerCase() === shownName(file.name).trim().toLowerCase();
  return same
    ? t("It becomes the newest version. The earlier versions stay in the file's history, and its sharing and links stay as they are.")
    : t("The file keeps its name, “{name}”: yours is not called that, and the name does not change. It becomes the newest version, the earlier versions stay in the file's history, and its sharing and links stay as they are.", { name: shownName(file.name) });
}

/** Asks, then uploads; true when the server has the new version. */
export async function addVersion(file: { id: string; name: string }, content: File, limits: Limits): Promise<boolean> {
  const why = tooBig(content, limits);
  if (why) {
    toast(why, "error");
    return false;
  }
  const ok = await confirmDialog({
    title: t("Upload “{value}” as a new version of “{name}”?", { value: content.name, name: shownName(file.name) }),
    message: versionMessage(file, content),
    confirmLabel: t("Upload as a new version"),
  });
  if (!ok) return false;
  try {
    // Sent by Drive itself, with a watchdog on the bytes moving, tries again after drops and stalls, and its own line in the uploads list.
    const { track } = await import("./largeUploads");
    const { uploadSingle } = await import("./partsUpload");
    const url = `/api/app/drive/files/${file.id}/versions?${new URLSearchParams({ comment: t("Uploaded “{name}”", { name: content.name }) })}`;
    await track({ name: shownName(file.name), size: content.size }, (report, signal) => uploadSingle(content, url, report, signal));
    toast(t("“{name}” has a new version", { name: shownName(file.name) }));
    return true;
  } catch (e) {
    toast(errorMessage(e), "error");
    return false;
  }
}
