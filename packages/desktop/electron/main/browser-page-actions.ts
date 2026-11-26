import {
  captureDomOutline,
  captureDomSnapshot,
  capturePageImage,
  captureRegionScreenshot,
  evaluateInPage,
  type BrowserDomOutline,
  type BrowserDomSnapshot,
  type BrowserEvalResult,
} from "./browser-dom";
import {
  clickTarget as clickTargetOnPage,
  fillTarget as fillTargetOnPage,
  hoverTarget as hoverTargetOnPage,
  resolveTarget,
  waitFor as waitForOnPage,
  type BrowserTarget,
  type BrowserWaitResult,
  type ResolvedTarget,
} from "./browser-interactions";
import { assertBrowserMutationAllowed, externalAutomationMatches } from "./browser-manager-utils";
import { scaleBrowserInputPoint } from "./browser-input-geometry";
import { browserScreenshotClipScale } from "./browser-screenshot";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserBounds } from "./browser-types";

// A tab unlocked via `browser_open_external_url` or explicit user sharing may
// be mutated only while it stays on the approved origin; otherwise fall back to
// the localhost-only gate.
function assertMutatingAllowed(tab: ManagedTab): void {
  const liveUrl = tab.webContents.getURL();
  if (externalAutomationMatches(liveUrl, tab.externalAutomationOrigin)) return;
  assertBrowserMutationAllowed(liveUrl);
}

export function snapshotPage(
  tab: ManagedTab,
  selector?: string,
  maxLength?: number,
  format?: string,
): Promise<BrowserDomSnapshot | BrowserDomOutline> {
  const wc = tab.webContents;
  return format === "html"
    ? captureDomSnapshot(wc, selector, maxLength)
    : captureDomOutline(wc, selector, maxLength);
}

export function screenshotPage(tab: ManagedTab, clip?: BrowserBounds): Promise<string> {
  const wc = tab.webContents;
  return clip
    ? captureRegionScreenshot(wc, clip, browserScreenshotClipScale(tab))
    : capturePageImage(wc);
}

export async function screenshotTargetPage(
  tab: ManagedTab,
  target: BrowserTarget,
  authorize: () => void = () => undefined,
): Promise<string> {
  const wc = tab.webContents;
  const { boundingBox } = await resolveTarget(wc, target);
  authorize();
  return captureRegionScreenshot(wc, boundingBox, browserScreenshotClipScale(tab));
}

export function evaluatePage(tab: ManagedTab, script: string): Promise<BrowserEvalResult> {
  assertMutatingAllowed(tab);
  clearPopupGesture(tab);
  return evaluateInPage(tab.webContents, script);
}

export function clickPage(
  tab: ManagedTab,
  x: number,
  y: number,
  inputScale: () => number = () => 1,
): void {
  assertMutatingAllowed(tab);
  const wc = tab.webContents;
  const point = scaleBrowserInputPoint(x, y, inputScale());
  markSyntheticPopupInput(tab, "mouse");
  wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

export function typeTextPage(tab: ManagedTab, text: string): void {
  assertMutatingAllowed(tab);
  clearPopupGesture(tab);
  tab.webContents.insertText(text);
}

export function keypressPage(tab: ManagedTab, keyCode: string): void {
  assertMutatingAllowed(tab);
  // Electron accepts aliases such as Space/Return and normalizes them before
  // before-input-event. Mark every injected key and consume its exact event.
  markSyntheticPopupInput(tab, "key");
  tab.webContents.sendInputEvent({ type: "keyDown", keyCode });
}

export function clickTargetPage(
  tab: ManagedTab,
  target: BrowserTarget,
  authorize?: () => void,
  inputScale: () => number = () => 1,
): Promise<ResolvedTarget> {
  assertMutatingAllowed(tab);
  return clickTargetOnPage(
    tab.webContents,
    target,
    () => {
      assertMutatingAllowed(tab);
      authorize?.();
    },
    () => {
      markSyntheticPopupInput(tab, "mouse");
    },
    inputScale,
  );
}

export function hoverPage(
  tab: ManagedTab,
  target: BrowserTarget,
  authorize?: () => void,
  inputScale: () => number = () => 1,
): Promise<ResolvedTarget> {
  assertMutatingAllowed(tab);
  clearPopupGesture(tab);
  return hoverTargetOnPage(
    tab.webContents,
    target,
    () => {
      assertMutatingAllowed(tab);
      authorize?.();
    },
    inputScale,
  );
}

export function fillPage(tab: ManagedTab, target: BrowserTarget, value: string): Promise<void> {
  assertMutatingAllowed(tab);
  clearPopupGesture(tab);
  return fillTargetOnPage(tab.webContents, target, value);
}

function markSyntheticPopupInput(tab: ManagedTab, kind: "mouse" | "key"): void {
  clearPopupGesture(tab);
  if (kind === "mouse") tab.syntheticPopupMouseEvents += 1;
  else tab.syntheticPopupKeyEvents += 1;
  tab.syntheticPopupInputExpiresAt = Date.now() + 250;
}

function clearPopupGesture(tab: ManagedTab): void {
  tab.popupGestureAt = null;
}

export function waitForPage(
  tab: ManagedTab,
  opts: { selector?: string; text?: string },
  timeoutMs?: number,
): Promise<BrowserWaitResult> {
  return waitForOnPage(tab.webContents, opts, timeoutMs);
}
