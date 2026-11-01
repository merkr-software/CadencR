import { PROVIDER_IDS } from "./providers";
import { getCatalogProviderMetadata } from "./provider-catalog-registry";
import type { ProviderPromptCapabilities } from "@/api/generated";

export type PromptAttachmentKind = "image" | "document" | "text" | "audio" | "resource";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const AUDIO_MIME_TYPES = ["audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg"] as const;
const PDF_MIME_TYPES = ["application/pdf"] as const;
const SPREADSHEET_MIME_TYPES = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
const TEXT_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/csv",
] as const;
const OFFICE_MIME_TYPES = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  ...SPREADSHEET_MIME_TYPES,
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tsv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  log: "text/plain",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * First extension registered for a MIME type — the inverse of the map above,
 * used to name a downloaded file. `jpg` wins over `jpeg` by insertion order.
 */
export function extensionForMime(mimeType: string): string | undefined {
  return Object.keys(EXTENSION_TO_MIME).find((ext) => EXTENSION_TO_MIME[ext] === mimeType);
}

export function normalizeAttachmentMime(fileName: string, mimeType: string): string {
  if (mimeType) return mimeType;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_MIME[extension] ?? "application/octet-stream";
}

interface CatalogAttachmentPolicy {
  images: boolean;
  pdfs: boolean;
}

/**
 * What a provider without a built-in attachment policy accepts, from the ACP
 * prompt capabilities the host last observed for it. Text-like files are
 * always inlined as text; images need `image`, PDFs `embedded_context`.
 * Unknown capabilities keep the conservative default: images and text.
 */
function catalogAttachmentPolicy(
  capabilities: ProviderPromptCapabilities | null | undefined,
): CatalogAttachmentPolicy {
  if (!capabilities) return { images: true, pdfs: false };
  return { images: capabilities.image, pdfs: capabilities.embedded_context };
}

function capabilitiesFor(providerId: string | undefined): ProviderPromptCapabilities | null {
  return getCatalogProviderMetadata(providerId)?.promptCapabilities ?? null;
}

export function getAttachmentKindForProvider(
  providerId: string | undefined,
  fileName: string,
  mimeType: string,
  promptCapabilities: ProviderPromptCapabilities | null = capabilitiesFor(providerId),
): PromptAttachmentKind | null {
  const provider = providerId ?? PROVIDER_IDS.CODEX_CLI;
  const normalized = normalizeAttachmentMime(fileName, mimeType);
  if (provider === PROVIDER_IDS.CODEX_CLI) {
    if (isImageMime(normalized)) return "image";
    return isPdfMime(normalized) || isSpreadsheetMime(normalized) ? "document" : null;
  }
  if (provider === PROVIDER_IDS.OPENCODE) {
    return isImageMime(normalized) ? "image" : opencodeKind(normalized);
  }
  if (provider === PROVIDER_IDS.CLAUDE_CODE) {
    return isImageMime(normalized) ? "image" : claudeKind(normalized);
  }
  return catalogProviderKind(normalized, catalogAttachmentPolicy(promptCapabilities));
}

export function attachmentAcceptForProvider(
  providerId: string | undefined,
  promptCapabilities: ProviderPromptCapabilities | null = capabilitiesFor(providerId),
): string {
  const provider = providerId ?? PROVIDER_IDS.CODEX_CLI;
  const base = [...IMAGE_MIME_TYPES];
  if (provider === PROVIDER_IDS.CODEX_CLI) {
    return [...base, ...PDF_MIME_TYPES, ...SPREADSHEET_MIME_TYPES].join(",");
  }
  if (provider === PROVIDER_IDS.OPENCODE) {
    return [
      ...base,
      ...AUDIO_MIME_TYPES,
      ...PDF_MIME_TYPES,
      ...TEXT_MIME_TYPES,
      ...OFFICE_MIME_TYPES,
    ].join(",");
  }
  if (provider === PROVIDER_IDS.CLAUDE_CODE) {
    return [...base, ...PDF_MIME_TYPES, ...TEXT_MIME_TYPES].join(",");
  }
  const policy = catalogAttachmentPolicy(promptCapabilities);
  return [
    ...(policy.images ? IMAGE_MIME_TYPES : []),
    ...(policy.pdfs ? PDF_MIME_TYPES : []),
    ...TEXT_MIME_TYPES,
  ].join(",");
}

export function unsupportedAttachmentDescription(
  providerId: string | undefined,
  promptCapabilities: ProviderPromptCapabilities | null = capabilitiesFor(providerId),
): string {
  if (providerId === PROVIDER_IDS.OPENCODE) {
    return "OpenCode accepts images, audio, PDFs, text files, and common document resources.";
  }
  if (providerId === PROVIDER_IDS.CLAUDE_CODE) {
    return "Claude accepts images, PDFs, and text-like files such as TXT, CSV, Markdown, and JSON.";
  }
  if (providerId === undefined || providerId === PROVIDER_IDS.CODEX_CLI) {
    return "Codex accepts images, PDFs, and Excel spreadsheets.";
  }
  const policy = catalogAttachmentPolicy(promptCapabilities);
  const kinds = [policy.images ? "images" : null, policy.pdfs ? "PDFs" : null].filter(
    (kind): kind is string => kind !== null,
  );
  const textFiles = "text-like files such as TXT, CSV, Markdown, and JSON";
  return kinds.length > 0
    ? `This provider accepts ${kinds.join(", ")} and ${textFiles}.`
    : `This provider accepts ${textFiles}.`;
}

function opencodeKind(mimeType: string): PromptAttachmentKind | null {
  if (isAudioMime(mimeType)) return "audio";
  if (isTextMime(mimeType) || isPdfMime(mimeType) || isOfficeMime(mimeType)) return "resource";
  return null;
}

/**
 * Images go out as ACP image blocks, PDFs as `document` attachments the host
 * turns into embedded ACP resources, text-like files inline as text.
 */
function catalogProviderKind(
  mimeType: string,
  policy: CatalogAttachmentPolicy,
): PromptAttachmentKind | null {
  if (isImageMime(mimeType)) return policy.images ? "image" : null;
  if (isPdfMime(mimeType)) return policy.pdfs ? "document" : null;
  return isTextMime(mimeType) ? "text" : null;
}

function claudeKind(mimeType: string): PromptAttachmentKind | null {
  if (isPdfMime(mimeType) || mimeType === "text/plain") return "document";
  if (isTextMime(mimeType)) return "text";
  return null;
}

function isImageMime(mimeType: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isAudioMime(mimeType: string): boolean {
  return (AUDIO_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isPdfMime(mimeType: string): boolean {
  return (PDF_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isSpreadsheetMime(mimeType: string): boolean {
  return (SPREADSHEET_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || (TEXT_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isOfficeMime(mimeType: string): boolean {
  return (OFFICE_MIME_TYPES as readonly string[]).includes(mimeType);
}
