import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
/**
 * In-editor viewer for image files (PNG/JPG/GIF/WebP/BMP/ICO/AVIF).
 * Renders the bitmap with a transparency checkerboard backdrop, plus a
 * status row showing pixel dimensions and on-disk file size.
 *
 * Image bytes are fetched as a Blob via the API client (so auth
 * headers travel with the request) and exposed to the `<img>` element
 * through `URL.createObjectURL`.
 *
 * Zoom and pan match macOS Preview: trackpad pinch zooms around the
 * cursor, two-finger scroll pans, double-click resets to fit. The
 * geometry is driven by a single `transform: translate() scale()`
 * with `transform-origin: 0 0`; `userView === null` means "fit"
 * (recomputed on resize).
 */
import { useQuery } from "@tanstack/react-query";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatBytes } from "@/lib/diff-thresholds";
import { getFileName } from "@/lib/file-language";
import { readImageBlob, readImageBlobQueryKey } from "@/lib/read-image-blob";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { CheckerboardBackdrop } from "./CheckerboardBackdrop";

interface ImageFileViewerProps {
  filePath: string;
  projectId: number;
  featureId: number;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface View {
  scale: number;
  /** Image top-left, in container coordinates. */
  tx: number;
  ty: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const PINCH_SENSITIVITY = 0.01;

/** Fit + center, never upscaling — the convention image viewers use. */
function computeFitView(image: ImageDimensions, container: DOMRect): View {
  const scale = Math.min(container.width / image.width, container.height / image.height, 1);
  return {
    scale,
    tx: (container.width - image.width * scale) / 2,
    ty: (container.height - image.height * scale) / 2,
  };
}

/**
 * Keep the image inside the container: when it's larger than the pane
 * on an axis its edges stick to the pane edges; when smaller it
 * re-centers. Matches macOS Preview's pan behavior.
 */
function clampView(view: View, image: ImageDimensions, container: DOMRect): View {
  const renderedW = image.width * view.scale;
  const renderedH = image.height * view.scale;
  const tx =
    renderedW <= container.width
      ? (container.width - renderedW) / 2
      : Math.min(0, Math.max(container.width - renderedW, view.tx));
  const ty =
    renderedH <= container.height
      ? (container.height - renderedH) / 2
      : Math.min(0, Math.max(container.height - renderedH, view.ty));
  return { scale: view.scale, tx, ty };
}

function useImageFitView(
  containerRef: RefObject<HTMLDivElement | null>,
  rectRef: MutableRefObject<DOMRect | null>,
  dimensions: ImageDimensions | null,
  setFitView: Dispatch<SetStateAction<View | null>>,
): void {
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !dimensions) return;
    const refresh = (): void => {
      const rect = node.getBoundingClientRect();
      rectRef.current = rect;
      setFitView(computeFitView(dimensions, rect));
    };
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef, dimensions, rectRef, setFitView]);
}

function useImageWheelNavigation(
  containerRef: RefObject<HTMLDivElement | null>,
  rectRef: MutableRefObject<DOMRect | null>,
  dimensions: ImageDimensions | null,
  fitView: View | null,
  setUserView: Dispatch<SetStateAction<View | null>>,
): void {
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      const rect = rectRef.current;
      if (!dimensions || !rect) return;
      const isPinch = event.ctrlKey || event.metaKey;
      if (!isPinch && event.deltaX === 0 && event.deltaY === 0) return;
      event.preventDefault();
      setUserView((previous) => {
        const base = previous ?? fitView ?? computeFitView(dimensions, rect);
        if (!isPinch) {
          return clampView(
            {
              scale: base.scale,
              tx: base.tx - event.deltaX,
              ty: base.ty - event.deltaY,
            },
            dimensions,
            rect,
          );
        }
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const scale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, base.scale * Math.exp(-event.deltaY * PINCH_SENSITIVITY)),
        );
        const ratio = scale / base.scale;
        return clampView(
          { scale, tx: cx - (cx - base.tx) * ratio, ty: cy - (cy - base.ty) * ratio },
          dimensions,
          rect,
        );
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [containerRef, dimensions, fitView, rectRef, setUserView]);
}

interface ImageViewerContentProps {
  containerRef: RefObject<HTMLDivElement | null>;
  error: string | null;
  objectUrl: string | null;
  fileName: string;
  view: View | null;
  status: string;
  zoomLabel: string;
  onDoubleClick: () => void;
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError: () => void;
}

function ImageViewerContent({
  containerRef,
  error,
  objectUrl,
  fileName,
  view,
  status,
  zoomLabel,
  onDoubleClick,
  onLoad,
  onError,
}: ImageViewerContentProps) {
  return (
    <div className="h-full flex flex-col">
      <div
        ref={containerRef}
        onDoubleClick={onDoubleClick}
        className="flex-1 relative overflow-hidden"
      >
        {error ? (
          <div className="h-full flex items-center justify-center text-destructive text-sm px-6 text-center">
            {error}
          </div>
        ) : objectUrl === null ? (
          <div className="h-full flex items-center justify-center bg-background">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <CheckerboardBackdrop className="!overflow-hidden">
            <img
              src={objectUrl}
              alt={fileName}
              onLoad={onLoad}
              onError={onError}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transformOrigin: "0 0",
                transform: view
                  ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`
                  : "scale(0)",
                imageRendering: view && view.scale > 2 ? "pixelated" : "auto",
                visibility: view ? "visible" : "hidden",
              }}
              className="select-none max-w-none max-h-none"
              draggable={false}
            />
          </CheckerboardBackdrop>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-0.5 border-t border-border bg-card text-xs text-muted-foreground shrink-0">
        <span className="truncate">{status}</span>
        <span>{zoomLabel}</span>
      </div>
    </div>
  );
}

function ImageFileViewerImpl({ filePath, projectId, featureId }: ImageFileViewerProps) {
  const { t } = useUiTranslation();
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // `null` means "use the auto-computed fit view"; any value means the
  // user has taken manual control via pinch or pan.
  const [userView, setUserView] = useState<View | null>(null);
  const [fitView, setFitView] = useState<View | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The container rect is read on every wheel event; caching avoids
  // `getBoundingClientRect()` (forced layout) on the pinch hot path.
  const rectRef = useRef<DOMRect | null>(null);

  const imageQuery = useQuery({
    queryKey: readImageBlobQueryKey(projectId, featureId, filePath),
    queryFn: ({ signal }) => readImageBlob(projectId, featureId, filePath, signal),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const objectUrl = useObjectUrl(imageQuery.data);

  // Reset the per-image dimensions/zoom state whenever a new blob arrives.
  useEffect(() => {
    const blob = imageQuery.data;
    setDimensions(null);
    setDecodeError(null);
    setUserView(null);
    setFitView(null);
    setFileSize(blob ? blob.size : null);
  }, [imageQuery.data]);

  useEffect(() => {
    if (!imageQuery.error) return;
    const message = apiErrorMessage(
      imageQuery.error,
      translateUi("workspace.editor.imageFileViewer.loadFailed", "Failed to load image"),
    );
    // Sonner dedupes by `id`, so unrelated re-renders won't stack toasts.
    toast.error(message, { id: `image-viewer:${filePath}` });
  }, [filePath, imageQuery.error]);

  const handleImgLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
  }, []);

  const handleImgError = useCallback(() => {
    const message = translateUi(
      "workspace.editor.imageFileViewer.decodeFailed",
      "Failed to decode image",
    );
    setDecodeError(message);
    toast.error(message, { id: `image-viewer:${filePath}` });
  }, [filePath]);

  useImageFitView(containerRef, rectRef, dimensions, setFitView);
  useImageWheelNavigation(containerRef, rectRef, dimensions, fitView, setUserView);

  // Double-click resets — macOS Preview / Quick Look convention.
  const handleDoubleClick = useCallback(() => setUserView(null), []);

  const fileNameLabel = getFileName(filePath);
  const view = userView ?? fitView;
  const statusParts: string[] = [fileNameLabel];
  if (dimensions) statusParts.push(`${dimensions.width} × ${dimensions.height}`);
  if (fileSize !== null) statusParts.push(formatBytes(fileSize, t));
  const zoomLabel = view ? `${Math.round(view.scale * 100)}%` : "—";
  const error =
    decodeError ??
    (imageQuery.error
      ? apiErrorMessage(
          imageQuery.error,
          translateUi("workspace.editor.imageFileViewer.loadFailed", "Failed to load image"),
        )
      : null);

  return (
    <ImageViewerContent
      containerRef={containerRef}
      error={error}
      objectUrl={objectUrl}
      fileName={fileNameLabel}
      view={view}
      status={statusParts.join("  ·  ")}
      zoomLabel={zoomLabel}
      onDoubleClick={handleDoubleClick}
      onLoad={handleImgLoad}
      onError={handleImgError}
    />
  );
}

const ImageFileViewer = memo(ImageFileViewerImpl);
export default ImageFileViewer;
