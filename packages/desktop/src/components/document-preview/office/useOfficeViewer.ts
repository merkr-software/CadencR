import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { documentErrorMessage } from "../DocumentChrome";
import { loadOfficeFonts } from "./office-fonts";
import { prepareOfficeBytes } from "./office-bytes";

/** The slice of every `@silurus/ooxml` viewer the preview drives. */
export interface OfficeViewer {
  load(source: ArrayBuffer): Promise<void>;
  destroy(): void;
  /** 1 = the document's real size. */
  getScale(): number;
}

export type OfficeViewerState<V> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; viewer: V };

/**
 * Readable messages for the library's stable error codes. Matched on `code`
 * rather than `instanceof` so this shared module doesn't import (and bundle)
 * any one format's engine.
 */
const OOXML_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  encrypted: "This file is password-protected",
  "invalid-password": "This file is password-protected",
  "unsupported-encryption": "This file uses an encryption Cadencr can't open",
  "legacy-binary-format": "Legacy .doc / .xls / .ppt files can't be previewed",
  "not-ooxml": "This file isn't a valid Office document — it may be corrupt",
  "ooxml-resource-limit": "This file is too large to preview",
  "ooxml-decoded-image-limit": "This file's images are too large to preview",
};

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function officeErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  const known = code === null ? undefined : OOXML_ERROR_MESSAGES[code];
  return known ?? documentErrorMessage(error, fallback);
}

/**
 * Mount an ooxml viewer in the returned container and load `data` into it,
 * tracking its zoom for the status bar. `create` must be stable (it runs once
 * per document) and wire `onScaleChange` into the viewer's options; the
 * viewer is destroyed when `data` changes or the component unmounts.
 *
 * The viewer gets a copy of the bytes — the cached query buffer must stay
 * intact for the next mount, whatever the library does with its input —
 * checked and normalized first (see `office-bytes.ts`).
 */
export function useOfficeViewer<V extends OfficeViewer>(
  data: ArrayBuffer,
  create: (container: HTMLElement, onScaleChange: (scale: number) => void) => V,
  failure: string,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  state: OfficeViewerState<V>;
  viewer: V | null;
  scale: number | null;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<OfficeViewerState<V>>({ status: "loading" });
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    setState({ status: "loading" });
    const viewer = create(container, setScale);
    loadOfficeFonts()
      .then(() => viewer.load(prepareOfficeBytes(data)))
      .then(() => {
        if (!cancelled) setState({ status: "ready", viewer });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: officeErrorMessage(error, failure) });
      });
    return () => {
      cancelled = true;
      viewer.destroy();
    };
  }, [create, data, failure]);

  const viewer = state.status === "ready" ? state.viewer : null;
  useFitScaleSync(viewer, containerRef, setScale);
  return { containerRef, state, viewer, scale };
}

/**
 * `onError` handler for failures after the first paint (a page or slide that
 * fails while scrolling): the rest of the document stays usable, so it's a
 * toast rather than replacing the view. One toast per document.
 */
export function reportLateRenderError(toastId: string, failure: string) {
  return (error: Error): void => {
    toast.error(officeErrorMessage(error, failure), { id: toastId });
  };
}

/**
 * Keeps the status bar's zoom (1 = the document's real size) in step with
 * the viewer. `onScaleChange` covers user zooms, but the automatic
 * fit-to-width the viewers apply after loading and on every resize doesn't
 * report through it, so the scale is also re-read a frame after either.
 */
function useFitScaleSync(
  viewer: OfficeViewer | null,
  containerRef: RefObject<HTMLDivElement | null>,
  setScale: (scale: number) => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!viewer || !container) return undefined;
    let frame = requestAnimationFrame(() => setScale(viewer.getScale()));
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScale(viewer.getScale()));
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, setScale, viewer]);
}
