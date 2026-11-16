/**
 * PDF renderer: pdf.js pages stacked in a scroll container, each painted to a
 * canvas (plus a selectable text layer) only while near the viewport. Fits the
 * widest page to the pane by default; the status bar zooms in steps.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  PasswordException,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import { useInViewport } from "@/hooks/useInViewport";
import {
  DocumentError,
  DocumentLoading,
  DocumentStatusBar,
  DocumentZoomControls,
  documentErrorMessage,
  type ZoomableViewer,
} from "./DocumentChrome";
import { loadPdf } from "./pdfjs";
import type { DocumentRendererProps } from "./types";
import { useElementWidth } from "@/hooks/useElementSize";
import "./pdf-document.css";

interface PageSize {
  width: number;
  height: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; doc: PDFDocumentProxy; pages: PageSize[] };

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const PAGE_GUTTER_PX = 24;
/** Chromium refuses canvases past ~268M px; stay far below to bound memory. */
const MAX_CANVAS_PIXELS = 16_777_216;

function usePdfDocument(data: ArrayBuffer): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const task = loadPdf(data);
    task.promise
      .then(async (doc) => {
        const pages = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, index) => {
            const viewport = (await doc.getPage(index + 1)).getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        );
        if (!cancelled) setState({ status: "ready", doc, pages });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof PasswordException
            ? "This PDF is password-protected and can't be previewed"
            : documentErrorMessage(error, "Could not open PDF");
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data]);
  return state;
}

function nextZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.01) ?? current;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? current;
}

export default function PdfDocumentView({ data, fileName }: DocumentRendererProps): ReactElement {
  const state = usePdfDocument(data);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(scrollRef);
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const widestPage =
    state.status === "ready" ? Math.max(...state.pages.map((page) => page.width)) : 0;
  const fitScale =
    width && widestPage > 0 ? Math.max(0.25, (width - PAGE_GUTTER_PX * 2) / widestPage) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  const zoomControls = useMemo<ZoomableViewer>(() => {
    const zoomBy = (direction: 1 | -1): void =>
      setZoom(nextZoom(zoom === "fit" ? fitScale : zoom, direction));
    const fit = (): void => setZoom("fit");
    return { zoomIn: () => zoomBy(1), zoomOut: () => zoomBy(-1), fitWidth: fit, fitPage: fit };
  }, [fitScale, zoom]);

  return (
    <>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && <DocumentLoading label="Opening PDF…" />}
        {state.status === "error" && <DocumentError message={state.message} />}
        {state.status === "ready" && width !== null && (
          <div className="flex w-max min-w-full flex-col items-center gap-4 py-6">
            {state.pages.map((size, index) => (
              <PdfPage
                key={index}
                doc={state.doc}
                pageNumber={index + 1}
                size={size}
                scale={scale}
                scrollRoot={scrollRef}
              />
            ))}
          </div>
        )}
      </div>
      <DocumentStatusBar
        status={
          state.status === "ready"
            ? `${fileName} · ${state.doc.numPages} ${state.doc.numPages === 1 ? "page" : "pages"}`
            : fileName
        }
      >
        <DocumentZoomControls viewer={zoomControls} scale={scale} fitActive={zoom === "fit"} />
      </DocumentStatusBar>
    </>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  size: PageSize;
  scale: number;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}

const PdfPage = memo(function PdfPage({
  doc,
  pageNumber,
  size,
  scale,
  scrollRoot,
}: PdfPageProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  // Pages only hold a canvas near the viewport, which bounds a long PDF's memory.
  const { setRef, inView: near } = useInViewport(scrollRoot, "150% 0px");
  const error = usePageRender({ doc, pageNumber, scale, near, canvasRef, textRef });
  const style = useMemo(
    () =>
      ({
        width: `${Math.floor(size.width * scale)}px`,
        height: `${Math.floor(size.height * scale)}px`,
        "--scale-factor": String(scale),
      }) as React.CSSProperties,
    [scale, size.height, size.width],
  );

  return (
    <div
      ref={setRef}
      style={style}
      aria-label={`Page ${pageNumber}`}
      className="cadencr-pdf-page relative shrink-0 bg-white shadow-md ring-1 ring-black/5"
    >
      {near && <canvas ref={canvasRef} className="absolute inset-0 size-full" />}
      {near && <div ref={textRef} className="textLayer" />}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
});

function usePageRender({
  doc,
  pageNumber,
  scale,
  near,
  canvasRef,
  textRef,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  near: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  textRef: React.RefObject<HTMLDivElement | null>;
}): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!near) return undefined;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    const paint = async (): Promise<void> => {
      const loaded = await doc.getPage(pageNumber);
      page = loaded;
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (cancelled || !canvas || !textContainer) return;
      const viewport = loaded.getViewport({ scale });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      );
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      renderTask = loaded.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      textContainer.replaceChildren();
      textLayer = new TextLayer({
        textContentSource: loaded.streamTextContent(),
        container: textContainer,
        viewport,
      });
      await Promise.all([renderTask.promise, textLayer.render()]);
    };
    setError(null);
    paint().catch((reason: unknown) => {
      // A cancelled render (scrolled away, zoomed) rejects by design.
      if (cancelled || (reason instanceof Error && reason.name === "RenderingCancelledException")) {
        return;
      }
      setError(documentErrorMessage(reason, `Could not render page ${pageNumber}`));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      // Drop the page's parsed content and decoded images until it's painted again.
      page?.cleanup();
    };
  }, [canvasRef, doc, near, pageNumber, scale, textRef]);
  return error;
}
