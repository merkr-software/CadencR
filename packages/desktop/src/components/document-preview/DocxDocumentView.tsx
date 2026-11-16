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

const FAILURE = "Could not render Word document";

interface PageState {
  index: number;
  total: number;
  complete: boolean;
}

function pageStatus(fileName: string, page: PageState | null): string {
  if (!page || page.total === 0) return fileName;
  const total = page.complete ? String(page.total) : `${page.total}…`;
  return `${fileName} · Page ${page.index + 1} of ${total}`;
}

export default function DocxDocumentView({ data, fileName }: DocumentRendererProps): ReactElement {
  const [page, setPage] = useState<PageState | null>(null);
  const create = useCallback(
    (container: HTMLElement, onScaleChange: (scale: number) => void) =>
      new DocxScrollViewer(container, {
        ...PAGE_DESK,
        enableTextSelection: true,
        progressiveLayout: true,
        onVisiblePageChange: (index, total, complete) => setPage({ index, total, complete }),
        onScaleChange,
        onError: reportLateRenderError(`docx-render:${fileName}`, FAILURE),
      }),
    [fileName],
  );
  const { containerRef, state, viewer, scale } = useOfficeViewer(data, create, FAILURE);

  return (
    <>
      <OfficeViewerFrame
        containerRef={containerRef}
        state={state}
        loadingLabel="Laying out Word document…"
      />
      <DocumentStatusBar status={pageStatus(fileName, page)}>
        <DocumentZoomControls viewer={viewer} scale={scale} />
      </DocumentStatusBar>
    </>
  );
}
