/**
 * pdf.js wiring for the document preview. The worker is a bundled asset (a CDN
 * worker would be blocked by the renderer CSP and fail offline), and the
 * CMaps / standard fonts / ICC profiles / image-decoder wasm are served from
 * the renderer origin by the `cadencr-static-asset-dirs` Vite plugin.
 *
 * The app uses a hash router, so the document directory is a stable base in
 * the dev server, the packaged `file://` shell, and the remote SPA alike.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = new URL("pdfjs/", new URL(".", window.location.href)).toString();

export function loadPdf(data: ArrayBuffer): PDFDocumentLoadingTask {
  return getDocument({
    // pdf.js transfers the buffer to its worker, which detaches it; the caller's
    // buffer is the React Query cache entry, so hand over a copy.
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
  });
}
