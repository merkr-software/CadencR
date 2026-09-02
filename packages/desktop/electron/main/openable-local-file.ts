import path from "node:path";

/**
 * File types that are safe to hand to the operating system's default document
 * or media viewer. Unknown types stay blocked so agent-authored Markdown cannot
 * turn `shell.openPath` into an executable, script, application, or shortcut
 * launcher.
 */
const OPENABLE_LOCAL_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".docx",
  ".gif",
  ".htm",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".m4a",
  ".m4v",
  ".markdown",
  ".md",
  ".mov",
  ".mp3",
  ".mp4",
  ".odp",
  ".ods",
  ".odt",
  ".ogg",
  ".pdf",
  ".png",
  ".pptx",
  ".rst",
  ".tif",
  ".tiff",
  ".toml",
  ".tsv",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
]);

export function assertOpenableLocalFile(canonicalPath: string): void {
  const extension = path.extname(canonicalPath).toLowerCase();
  if (!OPENABLE_LOCAL_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Files of type ${extension || "(no extension)"} cannot be opened from links.`);
  }
}
