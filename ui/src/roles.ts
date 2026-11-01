// The roles Drive grants, and the addresses people open an item by.

/** The roles Drive grants, with what each may do. */
export const ROLES = [
  { permission: "View", label: "Viewer", hint: "open and download" },
  { permission: "Comment", label: "Commenter", hint: "also comment" },
  { permission: "Edit", label: "Editor", hint: "also change, upload, rename and move" },
  { permission: "Manage", label: "Manager", hint: "also share" },
] as const;

export const roleLabel = (permission: string) => ROLES.find((r) => r.permission === permission)?.label ?? permission;

/** The address people in the workspace open: Drive shows the item, or offers to ask for access. */
export const itemLink = (id: string, kind: "file" | "folder" = "file") => `${location.origin}/open/${kind === "folder" ? "DriveFolder" : "DriveFile"}/${encodeURIComponent(id)}`;
