import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
/**
 * Word renderer: `@silurus/ooxml`'s DOCX engine (Rust/WASM parser, canvas
 * paint) laid out as a continuous, virtualized page view — real pagination,
 * headers and footers, tables, images and charts, with selectable text.
 *
 * Nothing from the file reaches the DOM as markup. Links are the library's:
 * bookmarks scroll the document, and web links go through `window.open`,
 * which the main process denies and hands to the system browser when the
 * URL is approved.
 */
import { useCallback, useState, type ReactElement } from "react";
import { DocxScrollViewer } from "@silurus/ooxml/docx";
import { DocumentStatusBar, DocumentZoomControls } from "./DocumentChrome";
import { OfficeViewerFrame } from "./office/OfficeViewerFrame";
import { PAGE_DESK } from "./office/page-desk";
import { reportLateRenderError, useOfficeViewer } from "./office/useOfficeViewer";
import type { DocumentRendererProps } from "./types";

const renderFailure = () =>
  translateUi("workspace.editor.docxDocumentView.renderFailed", "Could not render Word document");

interface PageState {
  index: number;
  total: number;
  complete: boolean;
}

function pageStatus(fileName: string, page: PageState | null, t: UiTranslator): string {
  if (!page || page.total === 0) return fileName;
  const values = { file: fileName, index: page.index + 1, total: page.total };
  return page.complete
    ? t(
        "workspace.editor.docxDocumentView.pageSummary",
        "{{file}} · Page {{index, number}} of {{total, number}}",
        values,
      )
    : t(
        "workspace.editor.docxDocumentView.partialPageSummary",
        "{{file}} · Page {{index, number}} of {{total, number}}…",
        values,
      );
}

export default function DocxDocumentView({ data, fileName }: DocumentRendererProps): ReactElement {
  const { t } = useUiTranslation();
  const [page, setPage] = useState<PageState | null>(null);
  const create = useCallback(
    (container: HTMLElement, onScaleChange: (scale: number) => void) =>
      new DocxScrollViewer(container, {
        ...PAGE_DESK,
        enableTextSelection: true,
        progressiveLayout: true,
        onVisiblePageChange: (index, total, complete) => setPage({ index, total, complete }),
        onScaleChange,
        onError: reportLateRenderError(`docx-render:${fileName}`, renderFailure),
      }),
    [fileName],
  );
  const { containerRef, state, viewer, scale } = useOfficeViewer(data, create);

  return (
    <>
      <OfficeViewerFrame
        containerRef={containerRef}
        state={state}
        failureLabel={t(
          "workspace.editor.docxDocumentView.renderFailed",
          "Could not render Word document",
        )}
        loadingLabel={t("workspace.editor.docxDocumentView.loading", "Laying out Word document…")}
      />
      <DocumentStatusBar status={pageStatus(fileName, page, t)}>
        <DocumentZoomControls viewer={viewer} scale={scale} />
      </DocumentStatusBar>
    </>
  );
}
