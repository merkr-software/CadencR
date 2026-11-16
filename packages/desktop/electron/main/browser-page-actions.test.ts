import { describe, expect, it, vi } from "vitest";
import {
  clickPage,
  clickTargetPage,
  hoverPage,
  screenshotPage,
  screenshotTargetPage,
} from "./browser-page-actions";
import type { ManagedTab } from "./browser-tab-events";

describe("browser page action authorization", () => {
  it("uses page zoom for desktop screenshot clips and raw CSS clips for mobile", async () => {
    const sendCommand = vi.fn(async () => ({ data: "png" }));
    const executeJavaScript = vi.fn<() => Promise<unknown>>(async () => undefined);
    const webContents = {
      getURL: () => "http://localhost:3000/",
      debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
      executeJavaScript,
      getZoomFactor: () => 1.2,
    } as unknown as Electron.WebContents;
    const tab = {
      metadata: {
        responsive: { enabled: true, mobile: false },
      },
      webContents,
    } as unknown as ManagedTab;

    await screenshotPage(tab, { x: 10, y: 20, width: 30, height: 40 });
    expect(sendCommand).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 12, y: 24, width: 36, height: 48, scale: 1 },
    });

    tab.metadata.responsive.mobile = true;
    executeJavaScript.mockResolvedValueOnce({
      found: true,
      boundingBox: { x: 10, y: 20, width: 30, height: 40 },
      center: { x: 25, y: 40 },
    });
    await screenshotTargetPage(tab, { ref: "e1" });
    expect(sendCommand).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 10, y: 20, width: 30, height: 40, scale: 1 },
    });
  });

  it("rechecks the live origin after target resolution before dispatching a click", async () => {
    let url = "http://localhost:3000/";
    let resolveTarget: (value: unknown) => void = () => {
      throw new Error("Target resolution did not start.");
    };
    const executeJavaScript = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTarget = resolve;
        }),
    );
    const webContents = {
      getURL: () => url,
      executeJavaScript,
      sendInputEvent: vi.fn(),
    } as unknown as Electron.WebContents;
    const tab = {
      webContents,
      view: { webContents },
      externalAutomationOrigin: null,
    } as unknown as ManagedTab;

    const pending = clickTargetPage(tab, { ref: "e1" });
    url = "https://authenticated.example.com/account";
    resolveTarget({
      found: true,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      center: { x: 5, y: 5 },
    });

    await expect(pending).rejects.toThrow("localhost");
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(executeJavaScript).toHaveBeenCalledOnce();
  });

  it("scales direct click coordinates at the final native input boundary", () => {
    const sendInputEvent = vi.fn();
    const webContents = {
      getURL: () => "http://localhost:3000/",
      sendInputEvent,
    } as unknown as Electron.WebContents;
    const tab = {
      webContents,
      externalAutomationOrigin: null,
      syntheticPopupMouseEvents: 0,
    } as unknown as ManagedTab;

    clickPage(tab, 101, 43, () => 0.5);

    expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseDown",
      x: 51,
      y: 22,
      button: "left",
      clickCount: 1,
    });
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "mouseUp",
      x: 51,
      y: 22,
      button: "left",
      clickCount: 1,
    });
  });

  it("scales resolved click and hover centers without scaling DOM screenshot geometry", async () => {
    const sendInputEvent = vi.fn();
    const resolved = {
      found: true,
      boundingBox: { x: 100, y: 40, width: 20, height: 10 },
      center: { x: 110, y: 45 },
    };
    const webContents = {
      getURL: () => "http://localhost:3000/",
      executeJavaScript: vi.fn(async () => resolved),
      sendInputEvent,
    } as unknown as Electron.WebContents;
    const tab = {
      webContents,
      externalAutomationOrigin: null,
      popupGestureAt: null,
      syntheticPopupMouseEvents: 0,
    } as unknown as ManagedTab;

    await clickTargetPage(tab, { ref: "e1" }, undefined, () => 0.4);
    await hoverPage(tab, { ref: "e1" }, undefined, () => 0.4);

    expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseDown",
      x: 44,
      y: 18,
      button: "left",
      clickCount: 1,
    });
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: "mouseUp",
      x: 44,
      y: 18,
      button: "left",
      clickCount: 1,
    });
    expect(sendInputEvent).toHaveBeenNthCalledWith(3, { type: "mouseMove", x: 44, y: 18 });
    expect(resolved.boundingBox).toEqual({ x: 100, y: 40, width: 20, height: 10 });
  });

  it("rejects a resolved click if responsive geometry changes during highlighting", async () => {
    let resolveHighlight: () => void = () => {
      throw new Error("Highlight did not start.");
    };
    let scriptCall = 0;
    const sendInputEvent = vi.fn();
    const executeJavaScript = vi.fn(() => {
      scriptCall += 1;
      if (scriptCall === 1) {
        return Promise.resolve({
          found: true,
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          center: { x: 5, y: 5 },
        });
      }
      return new Promise<void>((resolve) => {
        resolveHighlight = resolve;
      });
    });
    const webContents = {
      getURL: () => "http://localhost:3000/",
      executeJavaScript,
      sendInputEvent,
    } as unknown as Electron.WebContents;
    const tab = {
      webContents,
      externalAutomationOrigin: null,
      syntheticPopupMouseEvents: 0,
    } as unknown as ManagedTab;
    let viewportRevision = 1;
    const capturedRevision = viewportRevision;
    const inputScale = (): number => {
      if (viewportRevision !== capturedRevision) throw new Error("Browser viewport changed");
      return 0.5;
    };
    const pending = clickTargetPage(tab, { ref: "e1" }, undefined, inputScale);
    await vi.waitFor(() => expect(scriptCall).toBe(2));

    viewportRevision += 1;
    resolveHighlight();

    await expect(pending).rejects.toThrow("viewport changed");
    expect(sendInputEvent).not.toHaveBeenCalled();
  });
});
