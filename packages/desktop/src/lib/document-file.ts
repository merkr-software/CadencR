import type { QueryClient } from "@tanstack/react-query";
import { customInstanceResponse } from "@/api/client";
import { getFileExtension } from "@/lib/file-language";

/**
 * Document formats the desktop previews read-only — in the Preview tab, and
 * (for the binary ones) in place of CodeMirror when opened in the Editor.
 *
 * Must stay in lockstep with the service's `document_mime_for_path`
 * allowlist (`packages/service/src/shared/document_file.rs`). Only the OOXML
 * Office formats: legacy binary `.doc` / `.xls` / `.ppt` have no browser
 * parser. `csv` covers `.csv` and `.tsv`.
 */
export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx" | "csv";

const DOCUMENT_KINDS: ReadonlyMap<string, DocumentKind> = new Map([
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["xlsx", "xlsx"],
  ["pptx", "pptx"],
  ["csv", "csv"],
  ["tsv", "csv"],
]);

export function getDocumentKind(filePath: string): DocumentKind | null {
  return DOCUMENT_KINDS.get(getFileExtension(filePath)) ?? null;
}

/** Any format the Preview tab renders (CSV / TSV included). */
export function isDocumentFile(filePath: string): boolean {
  return getDocumentKind(filePath) !== null;
}

/**
 * A binary format with no text buffer to edit: the Editor shows its preview
 * instead of CodeMirror, and Neovim hands it to the Preview tab. CSV / TSV
 * stay text — they edit as usual and show their table via the preview toggle.
 */
export function isBinaryDocumentFile(filePath: string): boolean {
  const kind = getDocumentKind(filePath);
  return kind !== null && kind !== "csv";
}

export const DOCUMENT_KIND_LABELS: Readonly<Record<DocumentKind, string>> = {
  pdf: "PDF",
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
  csv: "CSV file",
};

const READ_DOCUMENT_URL = "/api/editor/read-document";

/**
 * How the service filled in a workbook's formula results, from its
 * `X-Cadencr-Formulas` header. Absent when the file carried its own (any
 * workbook Excel, Sheets or LibreOffice saved).
 */
export type FormulaRecalc =
  | { status: "computed"; computed: number; unresolved: number }
  | { status: "failed"; reason: string };

export interface DocumentPayload {
  bytes: ArrayBuffer;
  formulas: FormulaRecalc | null;
}

const FORMULAS_HEADER = "x-cadencr-formulas";

/** Parse the form-encoded header: `computed=12&unresolved=1` or `error=<reason>`. */
export function parseFormulaRecalc(header: unknown): FormulaRecalc | null {
  if (typeof header !== "string" || header === "") return null;
  const fields = new URLSearchParams(header);
  const reason = fields.get("error");
  if (reason !== null) return { status: "failed", reason };
  const count = (name: string): number | null => {
    const value = fields.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const computed = count("computed");
  const unresolved = count("unresolved");
  if (computed === null || unresolved === null) {
    return { status: "failed", reason: `Unreadable recalculation summary: ${header}` };
  }
  return { status: "computed", computed, unresolved };
}

/**
 * Fetch a document's bytes for a project-relative path. Goes through the
 * API client so its auth header travels with the request; the parsers all
 * take an `ArrayBuffer`, so no object URL is involved.
 */
export async function readDocumentBytes(
  projectId: number,
  featureId: number,
  filePath: string,
  signal?: AbortSignal,
): Promise<DocumentPayload> {
  const response = await customInstanceResponse<ArrayBuffer>({
    url: READ_DOCUMENT_URL,
    params: { project_id: projectId, feature_id: featureId, file_path: filePath },
    responseType: "arraybuffer",
    signal,
  });
  return {
    bytes: response.data,
    formulas: parseFormulaRecalc(response.headers[FORMULAS_HEADER]),
  };
}

/**
 * React Query key for a document fetch. Starts with the URL so the editor's
 * `file_tree.changed` invalidation (exact-URL match) refreshes open previews.
 */
export function readDocumentQueryKey(
  projectId: number,
  featureId: number,
  filePath: string,
): readonly unknown[] {
  return [READ_DOCUMENT_URL, { project_id: projectId, feature_id: featureId, file_path: filePath }];
}

/**
 * Refetch the open previews of the documents a watcher event reports written
 * (`documents`: paths relative to the feature's editor root) — and only
 * those. A refetch re-reads up to 50 MB and, for a workbook saved without its
 * formula results, recomputes them, so unrelated file changes must not.
 */
export function invalidateChangedDocuments(
  client: QueryClient,
  payload: Record<string, unknown>,
): void {
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const changed = new Set(documents.filter((path): path is string => typeof path === "string"));
  if (changed.size === 0) return;
  void client.invalidateQueries({
    predicate: ({ queryKey: [url, params] }) =>
      url === READ_DOCUMENT_URL &&
      typeof params === "object" &&
      params !== null &&
      "file_path" in params &&
      typeof params.file_path === "string" &&
      changed.has(params.file_path),
  });
}

/**
 * Byte equality, used as the query's structural sharing: a file-tree refetch
 * that returns the same bytes keeps the previous buffer, so the rendered
 * document doesn't re-parse and flash on every unrelated file change.
 */
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameFormulaRecalc(a: FormulaRecalc | null, b: FormulaRecalc | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The previous payload when `next` is the same document, so nothing re-renders. */
export function shareDocumentPayload(previous: unknown, next: unknown): unknown {
  if (!isDocumentPayload(previous) || !isDocumentPayload(next)) return next;
  return sameBytes(previous.bytes, next.bytes) &&
    sameFormulaRecalc(previous.formulas, next.formulas)
    ? previous
    : next;
}

function isDocumentPayload(value: unknown): value is DocumentPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "bytes" in value &&
    value.bytes instanceof ArrayBuffer
  );
}
