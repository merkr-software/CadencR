/**
 * Excel renderer: `@silurus/ooxml`'s XLSX engine (Rust/WASM parser, canvas
 * paint) — cell styles, number formats, merges, frozen panes, charts and
 * images, with the workbook's own sheet tabs. Formulas show the results the
 * file saved — or, for a workbook saved without them, the ones the service
 * computed (`formulas`), flagged in the status bar.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { XlsxViewer } from "@silurus/ooxml/xlsx";
import { DocumentStatusBar, DocumentZoomControls } from "./DocumentChrome";
import { FormulaRecalcNotice } from "./office/FormulaRecalcNotice";
import { OfficeViewerFrame } from "./office/OfficeViewerFrame";
import { reportLateRenderError, useOfficeViewer } from "./office/useOfficeViewer";
import type { DocumentRendererProps } from "./types";

const FAILURE = "Could not render Excel workbook";

export default function XlsxDocumentView({
  data,
  formulas,
  fileName,
}: DocumentRendererProps): ReactElement {
  const [sheetName, setSheetName] = useState<string | null>(null);
  const create = useCallback(
    (container: HTMLElement, onScaleChange: (scale: number) => void) => {
      const viewer: XlsxViewer = new XlsxViewer(container, {
        // Zoom lives in the status bar, like every other document kind.
        showZoomSlider: false,
        onScaleChange,
        onSheetChange: (index) => setSheetName(viewer.sheetNames[index] ?? null),
        onError: reportLateRenderError(`xlsx-render:${fileName}`, FAILURE),
      });
      return viewer;
    },
    [fileName],
  );
  const { containerRef, state, viewer, scale } = useOfficeViewer(data, create, FAILURE);
  useEffect(() => {
    if (!viewer) return;
    setSheetName(viewer.sheetNames[viewer.sheetIndex] ?? null);
  }, [viewer]);

  return (
    <>
      <OfficeViewerFrame
        containerRef={containerRef}
        state={state}
        loadingLabel="Opening workbook…"
      />
      <DocumentStatusBar status={sheetName ? `${fileName} · ${sheetName}` : fileName}>
        {formulas && <FormulaRecalcNotice formulas={formulas} />}
        <DocumentZoomControls viewer={viewer} scale={scale} />
      </DocumentStatusBar>
    </>
  );
}
