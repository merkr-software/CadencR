export function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? "";
}

export function getFileNameLower(filePath: string): string {
  return getFileName(filePath).toLowerCase();
}

export function getFileExtension(filePath: string): string {
  return getFileNameLower(filePath).split(".").at(-1) ?? "";
}

export function isDockerfilePath(filePath: string): boolean {
  const fileName = getFileNameLower(filePath);
  return (
    fileName === "dockerfile" ||
    fileName.startsWith("dockerfile.") ||
    fileName.endsWith(".dockerfile")
  );
}

/**
 * True when `filePath` looks like an env file: `.env`, `.env.local`,
 * `local.env`, `development.env`, `api.env`, etc. Matches the backend
 * helper in `packages/service/src/shared/env_file.rs` so the editor's
 * language detection and the file-listing endpoints agree.
 */
export function isEnvFilePath(filePath: string): boolean {
  const fileName = getFileNameLower(filePath);
  return fileName === ".env" || fileName.startsWith(".env.") || fileName.endsWith(".env");
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === "md" || ext === "mdx";
}

export function isHtmlFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === "html" || ext === "htm";
}

export function isSvgFile(filePath: string): boolean {
  return getFileExtension(filePath) === "svg";
}

export function isDelimitedTextFile(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === "csv" || ext === "tsv";
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(filePath));
}

/**
 * True for `.excalidraw` scene files. These open in the embedded Excalidraw
 * canvas editor (see `ExcalidrawEditor`) instead of the raw JSON in CodeMirror.
 */
export function isExcalidrawFile(filePath: string): boolean {
  return getFileExtension(filePath) === "excalidraw";
}

export type PreviewKind = "markdown" | "html" | "svg" | "csv";

/**
 * Returns the kind of preview a file supports, or `null` when the file
 * type has no in-editor preview surface. Used by `CodeMirrorEditor` to
 * decide whether to expose the status-bar preview toggle and what to
 * render when toggled on.
 */
export function getPreviewKind(filePath: string): PreviewKind | null {
  if (isMarkdownFile(filePath)) return "markdown";
  if (isHtmlFile(filePath)) return "html";
  if (isSvgFile(filePath)) return "svg";
  if (isDelimitedTextFile(filePath)) return "csv";
  return null;
}
