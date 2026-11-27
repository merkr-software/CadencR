import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
/**
 * PowerPoint renderer: `@silurus/ooxml`'s PPTX engine (Rust/WASM parser,
 * canvas paint) as a continuous, virtualized slide column — themes, preset
 * and custom shapes, tables, charts and effects, with selectable text. No
 * animations or transitions: this is a reader, not a slideshow.
 *
 * ←/→ and PageUp/PageDown step between slides while the deck has focus.
 */
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { PptxScrollViewer } from "@silurus/ooxml/pptx";
import { DocumentStatusBar, DocumentToolButton, DocumentZoomControls } from "./DocumentChrome";
import { OfficeViewerFrame } from "./office/OfficeViewerFrame";
import { PAGE_DESK } from "./office/page-desk";
import { reportLateRenderError, useOfficeViewer } from "./office/useOfficeViewer";
import type { DocumentRendererProps } from "./types";

const renderFailure = () =>
  translateUi(
    "workspace.editor.pptxDocumentView.renderFailed",
    "Could not render PowerPoint presentation",
  );
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown"]);

export default function PptxDocumentView({ data, fileName }: DocumentRendererProps): ReactElement {
  const { t } = useUiTranslation();
  const [slide, setSlide] = useState({ index: 0, total: 0 });
  const create = useCallback(
    (container: HTMLElement, onScaleChange: (scale: number) => void) =>
      new PptxScrollViewer(container, {
        ...PAGE_DESK,
        enableTextSelection: true,
        progressiveLayout: true,
        onVisibleSlideChange: (index, total) => setSlide({ index, total }),
        onScaleChange,
        onError: reportLateRenderError(`pptx-render:${fileName}`, renderFailure),
      }),
    [fileName],
  );
  const { containerRef, state, viewer, scale } = useOfficeViewer(data, create);
  useEffect(() => {
    if (!viewer) return;
    setSlide({ index: viewer.topVisibleSlide, total: viewer.slideCount });
    // A deck reads one whole slide at a time, not one slide width.
    viewer.fitPage();
  }, [viewer]);

  const goTo = useCallback(
    (index: number) => {
      if (!viewer) return;
      viewer.scrollToSlide(Math.max(0, Math.min(viewer.slideCount - 1, index)));
    },
    [viewer],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !viewer) return;
      if (PREVIOUS_KEYS.has(event.key)) goTo(slide.index - 1);
      else if (NEXT_KEYS.has(event.key)) goTo(slide.index + 1);
      else return;
      event.preventDefault();
    },
    [goTo, slide.index, viewer],
  );

  const status =
    slide.total > 0
      ? t(
          "workspace.editor.pptxDocumentView.slideSummary",
          "{{file}} · Slide {{index, number}} of {{total, number}}",
          { file: fileName, index: slide.index + 1, total: slide.total },
        )
      : fileName;
  return (
    <>
      <OfficeViewerFrame
        containerRef={containerRef}
        state={state}
        failureLabel={t(
          "workspace.editor.pptxDocumentView.renderFailed",
          "Could not render PowerPoint presentation",
        )}
        loadingLabel={t("workspace.editor.pptxDocumentView.loading", "Laying out slides…")}
        onKeyDown={onKeyDown}
      />
      <DocumentStatusBar status={status}>
        <DocumentZoomControls viewer={viewer} scale={scale} fit="page">
          <DocumentToolButton
            label={t("workspace.editor.pptxDocumentView.previousSlide", "Previous slide")}
            disabled={slide.index === 0}
            onClick={() => goTo(slide.index - 1)}
          >
            <ChevronLeftIcon />
          </DocumentToolButton>
          <DocumentToolButton
            label={t("workspace.editor.pptxDocumentView.nextSlide", "Next slide")}
            disabled={slide.index >= slide.total - 1}
            onClick={() => goTo(slide.index + 1)}
          >
            <ChevronRightIcon />
          </DocumentToolButton>
        </DocumentZoomControls>
      </DocumentStatusBar>
    </>
  );
}
