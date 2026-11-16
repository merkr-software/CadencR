import type { Session } from "electron";
import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { declaredTooLarge, readBounded } from "./bounded-body";

// Keeps the resulting base64 data URL below the renderer's 256 KiB limit.
export const MAX_FAVICON_BYTES = 190 * 1024;
const FAVICON_TIMEOUT_MS = 5_000;
const SVG_MIME_TYPE = "image/svg+xml";
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  SVG_MIME_TYPE,
]);

/** Fetch a favicon inside its guest session and return renderer-safe inline bytes. */
export async function faviconDataUrl(
  guestSession: Pick<Session, "fetch">,
  rawUrl: string | undefined,
  signal?: AbortSignal,
  rasterizeSvg?: (bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string | null>,
): Promise<string | null> {
  if (!rawUrl || !isHttpBrowserUrl(rawUrl)) return null;
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const response = await guestSession.fetch(rawUrl, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok || (response.url && !isHttpBrowserUrl(response.url))) {
      return cancelResponse(response);
    }
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) return cancelResponse(response);
    if (declaredTooLarge(response.headers.get("content-length"), MAX_FAVICON_BYTES)) {
      return cancelResponse(response);
    }
    const bytes = await readBounded(response.body, MAX_FAVICON_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    if (mimeType === SVG_MIME_TYPE) {
      return rasterizeSvg ? await rasterizeSvg(bytes, controller.signal) : null;
    }
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function cancelResponse(response: Response): Promise<null> {
  await response.body?.cancel();
  return null;
}
