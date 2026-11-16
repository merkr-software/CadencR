import { describe, expect, it, vi } from "vitest";
import {
  captureDomOutline,
  captureDomSnapshot,
  captureElementContext,
  capturePageImage,
  captureRegionScreenshot,
  captureScreenshot,
  evaluateInPage,
  flashHighlight,
} from "./browser-dom";

interface MockWebContents {
  getURL: () => string;
  debugger: {
    isAttached: () => boolean;
    attach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
  capturePage: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
}

function mockWebContents(overrides: Partial<MockWebContents> = {}): MockWebContents {
  return {
    getURL: () => "http://localhost:3000/",
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => ({ data: "png-data" })),
    },
    capturePage: vi.fn(),
    executeJavaScript: vi.fn(),
    ...overrides,
  };
}

function asWebContents(mock: MockWebContents): Electron.WebContents {
  return mock as unknown as Electron.WebContents;
}

describe("capturePageImage", () => {
  it("treats the exact unavailable display surface rejection as an empty preview", async () => {
    const wc = mockWebContents({
      capturePage: vi.fn(async () => {
        throw new Error("Current display surface not available for capture");
      }),
    });

    await expect(capturePageImage(asWebContents(wc))).resolves.toBe("");
  });

  it("preserves every other capture failure", async () => {
    const wc = mockWebContents({
      capturePage: vi.fn(async () => {
        throw new Error("Current display surface was destroyed");
      }),
    });

    await expect(capturePageImage(asWebContents(wc))).rejects.toThrow(
      "Current display surface was destroyed",
    );
  });
});

describe("captureScreenshot", () => {
  it("returns the base64 image data from CDP", async () => {
    const wc = mockWebContents();
    await expect(captureScreenshot(asWebContents(wc))).resolves.toBe("png-data");
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
    });
  });

  it("forwards a clip region to CDP", async () => {
    const wc = mockWebContents();
    await captureScreenshot(asWebContents(wc), { x: 1, y: 2, width: 3, height: 4 }, 2);
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 2, y: 4, width: 6, height: 8, scale: 1 },
    });
  });

  it("throws when CDP returns no image data", async () => {
    const wc = mockWebContents({
      debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
    });
    await expect(captureScreenshot(asWebContents(wc))).rejects.toThrow("did not return image data");
  });
});

describe("captureElementContext", () => {
  it("reads the screenshot scale after the user finishes picking", async () => {
    let resolveSelection!: (value: unknown) => void;
    const selection = new Promise<unknown>((resolve) => {
      resolveSelection = resolve;
    });
    const wc = mockWebContents({ executeJavaScript: vi.fn(() => selection) });
    let screenshotScale = 1;

    const result = captureElementContext(
      asWebContents(wc),
      {
        tabId: "tab-1",
        url: "https://example.test",
        title: "Example",
        capturedAt: "2026-09-08T00:00:00.000Z",
      },
      { consoleErrors: [], failedNetworkRequests: [] },
      null,
      () => screenshotScale,
    );
    screenshotScale = 1.2;
    resolveSelection({
      selectorCandidates: ["h1"],
      tagName: "h1",
      attributes: {},
      boundingBox: { x: 10, y: 20, width: 30, height: 40 },
      computedStyles: {},
    });

    await expect(result).resolves.toMatchObject({ screenshotPngBase64: "png-data" });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 12, y: 24, width: 36, height: 48, scale: 1 },
    });
  });
});

describe("captureDomSnapshot", () => {
  it("returns the serialized snapshot when an element is found", async () => {
    const snapshot = { found: true, html: "<div></div>", truncated: false };
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => snapshot) });
    await expect(captureDomSnapshot(asWebContents(wc), "#root")).resolves.toEqual(snapshot);
  });

  it("throws when the page returns an unexpected shape", async () => {
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => "nope") });
    await expect(captureDomSnapshot(asWebContents(wc))).rejects.toThrow("capture failed");
  });
});

describe("captureDomOutline", () => {
  it("returns the outline payload when the page resolves", async () => {
    const outline = { found: true, outline: "[e1] button", refCount: 1, truncated: false };
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => outline) });
    await expect(captureDomOutline(asWebContents(wc), "#root")).resolves.toEqual(outline);
  });

  it("throws when the page returns an unexpected shape", async () => {
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => 7) });
    await expect(captureDomOutline(asWebContents(wc))).rejects.toThrow("outline capture failed");
  });
});

describe("captureRegionScreenshot", () => {
  it("captures the clip and then draws the live highlight", async () => {
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => undefined) });
    await expect(
      captureRegionScreenshot(asWebContents(wc), { x: 1, y: 2, width: 3, height: 4 }),
    ).resolves.toBe("png-data");
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 1, y: 2, width: 3, height: 4, scale: 1 },
    });
    expect(wc.executeJavaScript).toHaveBeenCalledOnce();
  });
});

describe("flashHighlight", () => {
  it("never throws when the overlay injection fails", async () => {
    const wc = mockWebContents({
      executeJavaScript: vi.fn(async () => {
        throw new Error("frame gone");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      flashHighlight(asWebContents(wc), { x: 0, y: 0, width: 1, height: 1 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("evaluateInPage", () => {
  it("wraps a successful result", async () => {
    const wc = mockWebContents({ executeJavaScript: vi.fn(async () => 42) });
    await expect(evaluateInPage(asWebContents(wc), "1 + 41")).resolves.toEqual({
      ok: true,
      result: 42,
    });
  });

  it("surfaces evaluation errors instead of throwing", async () => {
    const wc = mockWebContents({
      executeJavaScript: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(evaluateInPage(asWebContents(wc), "throw 1")).resolves.toEqual({
      ok: false,
      error: "boom",
    });
  });
});
