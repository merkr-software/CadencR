import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { VISUAL_FRAME_PATH } from "../../src/shared/visual-frame";

/**
 * The service's sandboxed visual shell (`/visual-frame`, `domain::visual_frame`)
 * must keep its own CSP through the renderer-wide override: the renderer
 * policy's `frame-ancestors 'none'` would refuse the frame, and dropping its
 * `sandbox` directive would un-sandbox the document. Navigating the frame
 * elsewhere is refused by the renderer's own `frame-src`.
 */
export function keepsOwnCsp(details: { url: string; resourceType: string }): boolean {
  if (details.resourceType !== "subFrame" || !isHttpBrowserUrl(details.url)) return false;
  return new URL(details.url).pathname === VISUAL_FRAME_PATH;
}
