import { t } from "@ferrum/client";
// The roles Drive grants, and the addresses people open an item by.

/** The roles Drive grants, with what each may do. */
export const ROLES = [
  { permission: "View", get label() { return t("Viewer"); }, get hint() { return t("open and download"); } },
  { permission: "Comment", get label() { return t("Commenter"); }, get hint() { return t("also comment"); } },
  { permission: "Edit", get label() { return t("Editor"); }, get hint() { return t("also change, upload, rename and move"); } },
  { permission: "Manage", get label() { return t("Manager"); }, get hint() { return t("also share"); } },
] as const;

export const roleLabel = (permission: string) => ROLES.find((r) => r.permission === permission)?.label ?? permission;

/** The address people in the workspace open: Drive shows the item, or offers to ask for access. */
export const itemLink = (id: string, kind: "file" | "folder" = "file") => `${location.origin}/open/${kind === "folder" ? "DriveFolder" : "DriveFile"}/${encodeURIComponent(id)}`;
