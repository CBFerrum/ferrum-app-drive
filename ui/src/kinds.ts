// What kind of file a name says it is, for the preview and the grid: how Drive shows it, and whether
// a thumbnail is worth fetching. Pure, so it is tested without a browser.

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "markdown" | "csv" | "json" | "code" | "text" | "office" | "live" | "none";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;
const CODE = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|less|html?|xml|ya?ml|toml|ini|conf|env|lua|swift|r|pl|vue|svelte|diff|patch|gradle|tf|proto)$/i;
const TEXT = /\.(txt|log|text|nfo|srt|vtt)$/i;
const OFFICE = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf)$/i;

/** How the preview shows a file. `fileType` is the server's word for it (`Text`, `Image`…), used for names with no helpful ending. */
export function previewKind(name: string, fileType?: string | null): PreviewKind {
  if (/\.fdoc$/i.test(name)) return "live";
  if (IMAGE.test(name)) return "image";
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  if (/\.(csv|tsv)$/i.test(name)) return "csv";
  if (/\.(json|geojson|jsonl)$/i.test(name)) return "json";
  if (CODE.test(name)) return "code";
  if (TEXT.test(name)) return "text";
  if (OFFICE.test(name)) return "office";
  return fileType === "Text" ? "text" : "none";
}

/** The most of a text file the preview reads. */
export const TEXT_MAX = 1024 * 1024;
/** The most rows of a table the preview draws. */
export const CSV_ROWS = 500;

/** Images a grid may show a thumbnail of: the browser draws them as they are, and there is no
 *  server-made thumbnail, so only a small original is worth fetching for a card. */
export const THUMB_MAX = 1024 * 1024;
export const thumbnailable = (name: string, size: number | null) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name) && size !== null && size > 0 && size <= THUMB_MAX;

/** The type's name in words, for the details (and the grid's second line). */
export function kindLabel(name: string, fileType?: string | null): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  return [fileType, ext && ext.length <= 5 ? ext : null].filter(Boolean).join(" · ");
}

/** Whether a file can be opened in an editor Drive hosts, by its type: an office file needs one. */
export const needsOfficeEditor = (name: string) => OFFICE.test(name);
