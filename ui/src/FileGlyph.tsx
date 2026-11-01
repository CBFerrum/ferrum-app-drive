// What a folder or file looks like in a list: an icon for its kind, in that kind's colour (the
// theme's chart colours, so dark mode and high contrast follow by themselves).

import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder, type LucideIcon, Presentation, Sheet } from "lucide-react";
import { type Look, lookOf } from "./files";

const GLYPHS: Record<Look, LucideIcon> = {
  folder: Folder,
  text: FileText,
  sheet: Sheet,
  slides: Presentation,
  pdf: FileText,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  file: File,
};

/** A folder, or what a file's name says it is, in its kind's colour. */
export function FileGlyph({ kind, name, size = 18 }: { kind: "file" | "folder"; name: string; size?: number }) {
  const look = lookOf(kind, name);
  const Glyph = GLYPHS[look];
  return <Glyph aria-hidden size={size} className={`drive-glyph drive-glyph-${look}`} />;
}
