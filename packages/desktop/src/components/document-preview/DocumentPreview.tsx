import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
/**
 * Read-only preview of a PDF / Word / Excel / PowerPoint / CSV file. The
 * single surface both the Preview tab and the Editor (for binary document
 * files) mount, so the two always render a document the same way.
 *
 * Bytes come from `/api/editor/read-document`; each format's renderer is its
 * own lazy chunk, so pdf.js and each Office engine (with its WASM parser)
 * only download when a file of that kind is first opened.
 */
import { lazy, memo, Suspense, type ComponentType, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  getDocumentKind,
  readDocumentBytes,
  readDocumentQueryKey,
  shareDocumentPayload,
  type DocumentKind,
} from "@/lib/document-file";
import { getFileName } from "@/lib/file-language";
import { DocumentError, DocumentLoading } from "./DocumentChrome";
import type { DocumentRendererProps } from "./types";

const RENDERERS: Record<DocumentKind, ComponentType<DocumentRendererProps>> = {
  pdf: lazy(() => import("./PdfDocumentView")),
  docx: lazy(() => import("./DocxDocumentView")),
  xlsx: lazy(() => import("./XlsxDocumentView")),
  pptx: lazy(() => import("./PptxDocumentView")),
  csv: lazy(() => import("./CsvDocumentView")),
};

interface DocumentPreviewProps {
  /** Path of the document, relative to the feature's editor root. */
  filePath: string;
  projectId: number;
  featureId: number;
}

export const DocumentPreview = memo(function DocumentPreview({
  filePath,
  projectId,
  featureId,
}: DocumentPreviewProps): ReactElement {
  const { t } = useUiTranslation();
  const kind = getDocumentKind(filePath);
  const query = useQuery({
    queryKey: readDocumentQueryKey(projectId, featureId, filePath),
    queryFn: ({ signal }) => readDocumentBytes(projectId, featureId, filePath, signal),
    enabled: kind !== null,
    // Fresh until the watcher reports this document written (or the user
    // reloads it): remounting a preview never re-reads the file.
    staleTime: Infinity,
    // Up to 50 MB per document: don't keep closed ones around for minutes.
    gcTime: 30_000,
    structuralSharing: shareDocumentPayload,
  });

  if (kind === null) {
    return (
      <DocumentError
        message={t(
          "workspace.editor.documentPreview.unsupported",
          "{{file}} is not a previewable document",
          { file: getFileName(filePath) },
        )}
      />
    );
  }
  const label = documentKindLabel(kind, t);
  if (query.error) {
    return (
      <DocumentError
        message={apiErrorMessage(
          query.error,
          t("workspace.editor.documentPreview.readFailed", "Could not read {{kind}}", {
            kind: label,
          }),
        )}
      />
    );
  }
  if (!query.data)
    return (
      <DocumentLoading
        label={t("workspace.editor.documentPreview.loading", "Loading {{kind}}…", { kind: label })}
      />
    );

  const Renderer = RENDERERS[kind];
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40" data-document-kind={kind}>
      <Suspense
        fallback={
          <DocumentLoading
            label={t("workspace.editor.documentPreview.loadingViewer", "Loading {{kind}} viewer…", {
              kind: label,
            })}
          />
        }
      >
        <Renderer
          data={query.data.bytes}
          formulas={query.data.formulas}
          fileName={getFileName(filePath)}
        />
      </Suspense>
    </div>
  );
});

function documentKindLabel(kind: DocumentKind, t: UiTranslator): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "docx":
      return t("workspace.editor.documentPreview.word", "Word document");
    case "xlsx":
      return t("workspace.editor.documentPreview.excel", "Excel workbook");
    case "pptx":
      return t("workspace.editor.documentPreview.powerpoint", "PowerPoint presentation");
    case "csv":
      return t("workspace.editor.documentPreview.csv", "CSV file");
  }
}
