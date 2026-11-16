import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  parseTrafficLightsCenter,
  setTrafficLightsCenter,
  trafficLightsPosition,
} from "./traffic-lights";

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const win = {
    setWindowButtonPosition: vi.fn(),
    webContents: {
      getZoomFactor: () => 1,
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    },
  };
  return {
    win,
    asWindow: win as unknown as BrowserWindow,
    emit: (e: string) => listeners.get(e)?.(),
  };
}

describe("traffic lights", () => {
  it("centers the 14pt buttons on the band, in window points", () => {
    expect(trafficLightsPosition(24, 1)).toEqual({ x: 12, y: 17 });
    // The band scales with the page zoom; the native buttons don't.
    expect(trafficLightsPosition(24, 1.5)).toEqual({ x: 12, y: 29 });
    expect(trafficLightsPosition(24, 0.5)).toEqual({ x: 12, y: 5 });
  });

  it("restores the system position for a null center", () => {
    expect(trafficLightsPosition(null, 1)).toBeNull();
  });

  it("validates the renderer's center", () => {
    expect(parseTrafficLightsCenter(null)).toBeNull();
    expect(parseTrafficLightsCenter(24)).toBe(24);
    expect(() => parseTrafficLightsCenter("24")).toThrow(/traffic lights center or null/);
    expect(() => parseTrafficLightsCenter(Number.NaN)).toThrow(/traffic lights center or null/);
    expect(() => parseTrafficLightsCenter(-1)).toThrow(/between 0 and 200/);
  });

  describe("on macOS", () => {
    const platform = process.platform;
    afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

    it("returns the lights to the system position when the renderer reloads", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { win, asWindow, emit } = fakeWindow();
      setTrafficLightsCenter(asWindow, 24);
      setTrafficLightsCenter(asWindow, 30);
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 12, y: 23 });
      expect(win.webContents.on).toHaveBeenCalledTimes(1);

      emit("did-navigate");
      expect(win.setWindowButtonPosition).toHaveBeenLastCalledWith(null);
    });
  });
});
