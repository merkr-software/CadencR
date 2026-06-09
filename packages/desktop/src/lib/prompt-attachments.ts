/**
 * Shared classification + formatting helpers for prompt attachments.
 *
 * Two kinds of attachment are supported in the agent composer:
 *   - **image** files travel to the agent as base64 `image` content blocks
 *     (the existing multimodal path).
 *   - **text** files (CSV, TSV, JSON, Markdown, …) have their contents
 *     embedded into the prompt text at send time. This is provider-neutral
 *     — every agent (Claude Code, Codex, OpenCode) reads plain text — so no
 *     backend/protocol change is needed to support them.
 */

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Text/data file extensions accepted as text attachments. Deliberately
 * scoped to data, docs, and config formats — source files usually live in
 * the repo the agent can already read.
 */
export const TEXT_ATTACHMENT_EXTENSIONS = [
  "csv",
  "tsv",
  "txt",
  "text",
  "log",
  "md",
  "markdown",
  "mdx",
  "json",
  "jsonc",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "html",
  "css",
  "sql",
];

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(TEXT_ATTACHMENT_EXTENSIONS);

export const MAX_ATTACHMENT_FILES = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
/** Text files are inlined into the prompt, so keep them prompt-sized. */
export const MAX_TEXT_BYTES = 1024 * 1024; // 1MB
/** PDFs are parsed to text in-app before inlining; cap the raw file size. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB

/** `accept` attribute for the file picker — images + PDF + text extensions. */
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_IMAGE_TYPES,
  "application/pdf",
  ".pdf",
  ...TEXT_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

/** User-facing hint listing what can be attached. */
export const ATTACHMENT_SUPPORT_HINT =
  "Attach images (PNG, JPEG, GIF, WebP), PDFs, or text files like CSV, TSV, JSON, and Markdown.";

export interface ImageAttachment {
  id: string;
  fileName: string;
  base64: string;
  mimeType: string;
  previewUrl: string;
}

/** A text/data file (CSV, JSON, …) inlined into the prompt at send time. */
export interface TextAttachment {
  id: string;
  fileName: string;
  text: string;
  sizeBytes: number;
}

export type PromptAttachment = ImageAttachment | TextAttachment;

export function isImageAttachment(attachment: PromptAttachment): attachment is ImageAttachment {
  return "base64" in attachment;
}

export function isTextAttachment(attachment: PromptAttachment): attachment is TextAttachment {
  return "text" in attachment;
}

export type AttachmentClass =
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | { kind: "pdf" }
  | { kind: "unsupported" };

export function getExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Decide how a file should be attached, from its name and (optional)
 * browser-reported MIME type. The extension is authoritative for text
 * files since browsers report CSV inconsistently (`text/csv`,
 * `application/vnd.ms-excel`, or empty).
 */
export function classifyAttachment(fileName: string, fileType?: string): AttachmentClass {
  if (fileType && ALLOWED_IMAGE_TYPES.includes(fileType)) {
    return { kind: "image", mimeType: fileType };
  }
  const ext = getExtension(fileName);
  const imageMime = IMAGE_EXTENSION_TO_MIME[ext];
  if (imageMime) return { kind: "image", mimeType: imageMime };
  if (ext === "pdf" || fileType === "application/pdf") return { kind: "pdf" };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text" };
  // Fallback: any file the browser tags as text (e.g. an extensionless
  // `text/plain` drop) is safe to inline.
  if (fileType?.startsWith("text/")) return { kind: "text" };
  return { kind: "unsupported" };
}

/** Decode a base64 string (from the desktop bridge) into raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Decode a base64 string as UTF-8 text. */
export function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

function longestBacktickRun(value: string): number {
  let max = 0;
  for (const match of value.matchAll(/`+/g)) max = Math.max(max, match[0].length);
  return max;
}

/**
 * Build the message text sent to the agent: the typed prompt followed by
 * each text attachment fenced in a code block labelled with its filename.
 * The fence length adapts so file contents containing backticks can't
 * break out of the block.
 */
export function formatTextAttachmentsForPrompt(
  text: string,
  files: ReadonlyArray<{ fileName: string; text: string }>,
): string {
  if (files.length === 0) return text;
  const blocks = files.map((file) => {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(file.text) + 1));
    const lang = getExtension(file.fileName);
    return `Attached file \`${file.fileName}\`:\n${fence}${lang}\n${file.text}\n${fence}`;
  });
  return [text.trim(), ...blocks].filter((part) => part.length > 0).join("\n\n");
}
