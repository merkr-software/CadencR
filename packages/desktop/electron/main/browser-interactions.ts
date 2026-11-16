import { executeBrowserScript } from "./browser-document-security";
import type { WebContents } from "electron";
import { flashHighlight } from "./browser-dom";
import { scaleBrowserInputPoint } from "./browser-input-geometry";
import { expectScriptResult, isRecord } from "./browser-manager-utils";
import {
  fillTargetScript,
  resolveTargetScript,
  waitForScript,
  type BrowserTarget,
} from "./browser-target-script";
import type { BrowserBounds } from "./browser-types";

export type { BrowserTarget };

export interface ResolvedTarget {
  boundingBox: BrowserBounds;
  center: { x: number; y: number };
}

export interface BrowserWaitResult {
  found: boolean;
  elapsedMs: number;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

export async function resolveTarget(
  wc: WebContents,
  target: BrowserTarget,
): Promise<ResolvedTarget> {
  const result = await executeBrowserScript(wc, resolveTargetScript(target));
  return expectScriptResult<ResolvedTarget>(
    result,
    (r) => r.found === true && isRecord(r.boundingBox) && isRecord(r.center),
    "Browser target could not be resolved.",
  );
}

export async function clickTarget(
  wc: WebContents,
  target: BrowserTarget,
  authorize: () => void = () => undefined,
  beforeInput: () => void = () => undefined,
  inputScale: () => number = () => 1,
): Promise<ResolvedTarget> {
  const resolved = await resolveTarget(wc, target);
  authorize();
  await flashHighlight(wc, resolved.boundingBox);
  authorize();
  const { x, y } = resolved.center;
  const point = scaleBrowserInputPoint(x, y, inputScale());
  beforeInput();
  wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  return resolved;
}

export async function hoverTarget(
  wc: WebContents,
  target: BrowserTarget,
  authorize: () => void = () => undefined,
  inputScale: () => number = () => 1,
): Promise<ResolvedTarget> {
  const resolved = await resolveTarget(wc, target);
  authorize();
  await flashHighlight(wc, resolved.boundingBox);
  authorize();
  wc.sendInputEvent({
    type: "mouseMove",
    ...scaleBrowserInputPoint(resolved.center.x, resolved.center.y, inputScale()),
  });
  return resolved;
}

export async function fillTarget(
  wc: WebContents,
  target: BrowserTarget,
  value: string,
): Promise<void> {
  const result = await executeBrowserScript(wc, fillTargetScript(target, value));
  expectScriptResult(result, (r) => r.ok === true, "Browser fill failed.");
}

export async function waitFor(
  wc: WebContents,
  opts: { selector?: string; text?: string },
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<BrowserWaitResult> {
  const result = await executeBrowserScript(wc, waitForScript(opts.selector, opts.text, timeoutMs));
  return expectScriptResult<BrowserWaitResult>(
    result,
    (r) => typeof r.found === "boolean" && typeof r.elapsedMs === "number",
    "Browser wait_for returned an unexpected result.",
  );
}

// Resolves once the active navigation settles (or after `timeoutMs`), so
// browser_open_url returns a loaded page instead of about:blank.
export function waitForLoad(wc: WebContents, timeoutMs = 10_000): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve();
  if (wc.isDestroyed()) {
    return Promise.reject(new Error("Browser tab closed while waiting for the page to load."));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      wc.off("did-stop-loading", done);
      wc.off("destroyed", closed);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const closed = (): void => {
      cleanup();
      reject(new Error("Browser tab closed while waiting for the page to load."));
    };
    const timer = setTimeout(done, timeoutMs);
    wc.once("did-stop-loading", done);
    wc.once("destroyed", closed);
  });
}
