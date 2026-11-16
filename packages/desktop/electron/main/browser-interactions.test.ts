import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  clickTarget,
  fillTarget,
  hoverTarget,
  resolveTarget,
  waitFor,
  waitForLoad,
} from "./browser-interactions";

interface MockWebContents {
  getURL: () => string;
  executeJavaScript: ReturnType<typeof vi.fn>;
  sendInputEvent: ReturnType<typeof vi.fn>;
}

function mockWebContents(result: unknown): MockWebContents {
  return {
    getURL: () => "http://localhost:3000/",
    executeJavaScript: vi.fn(async () => result),
    sendInputEvent: vi.fn(),
  };
}

function asWebContents(mock: MockWebContents): Electron.WebContents {
  return mock as unknown as Electron.WebContents;
}

const RESOLVED = {
  found: true,
  boundingBox: { x: 10, y: 20, width: 40, height: 20 },
  center: { x: 30, y: 30 },
};

describe("resolveTarget", () => {
  it("returns the bounding box and center", async () => {
    const wc = mockWebContents(RESOLVED);
    await expect(resolveTarget(asWebContents(wc), { ref: "e1" })).resolves.toEqual({
      found: true,
      boundingBox: { x: 10, y: 20, width: 40, height: 20 },
      center: { x: 30, y: 30 },
    });
  });

  it("throws the page error for a stale ref", async () => {
    const wc = mockWebContents({ found: false, error: "Unknown or stale ref e9" });
    await expect(resolveTarget(asWebContents(wc), { ref: "e9" })).rejects.toThrow("stale ref e9");
  });
});

describe("clickTarget", () => {
  it("flashes then dispatches mouse events at the element center", async () => {
    const wc = mockWebContents(RESOLVED);
    await clickTarget(asWebContents(wc), { selector: ".btn" });
    // One call resolves the target, one draws the highlight.
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(wc.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseDown",
      x: 30,
      y: 30,
      button: "left",
      clickCount: 1,
    });
    expect(wc.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseUp",
      x: 30,
      y: 30,
      button: "left",
      clickCount: 1,
    });
  });
});

describe("hoverTarget", () => {
  it("moves the mouse to the element center", async () => {
    const wc = mockWebContents(RESOLVED);
    await hoverTarget(asWebContents(wc), { ref: "e2" });
    expect(wc.sendInputEvent).toHaveBeenCalledWith({ type: "mouseMove", x: 30, y: 30 });
  });
});

describe("fillTarget", () => {
  it("resolves when the page reports ok", async () => {
    const wc = mockWebContents({ found: true, ok: true });
    await expect(fillTarget(asWebContents(wc), { ref: "e1" }, "hi")).resolves.toBeUndefined();
  });

  it("throws the page error when the field is not found", async () => {
    const wc = mockWebContents({ found: false, error: "No element matched selector: #x" });
    await expect(fillTarget(asWebContents(wc), { selector: "#x" }, "hi")).rejects.toThrow(
      "No element matched",
    );
  });
});

describe("waitFor", () => {
  it("returns the page result", async () => {
    const wc = mockWebContents({ found: true, elapsedMs: 120 });
    await expect(waitFor(asWebContents(wc), { selector: "#ok" })).resolves.toEqual({
      found: true,
      elapsedMs: 120,
    });
  });
});

describe("waitForLoad", () => {
  it("rejects and cleans up when the tab closes during navigation", async () => {
    const wc = Object.assign(new EventEmitter(), mockWebContents(null), {
      isLoading: vi.fn(() => true),
      isDestroyed: vi.fn(() => false),
    });

    const waiting = waitForLoad(asWebContents(wc));
    wc.emit("destroyed");

    await expect(waiting).rejects.toThrow("Browser tab closed");
    expect(wc.listenerCount("did-stop-loading")).toBe(0);
    expect(wc.listenerCount("destroyed")).toBe(0);
  });
});
