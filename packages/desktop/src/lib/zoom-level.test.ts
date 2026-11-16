import { describe, expect, it } from "vitest";
import { clampZoom, parseZoomLevel, stepZoom } from "./zoom-level";

describe("zoom levels", () => {
  it("clamps to 50%–200%", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(250)).toBe(200);
    expect(clampZoom(130)).toBe(130);
  });

  it("steps by 10% within bounds and resets to 100%", () => {
    expect(stepZoom(100, "in")).toBe(110);
    expect(stepZoom(100, "out")).toBe(90);
    expect(stepZoom(200, "in")).toBe(200);
    expect(stepZoom(50, "out")).toBe(50);
    expect(stepZoom(170, "reset")).toBe(100);
  });

  it("reads unset, empty or non-numeric values as the default and clamps the rest", () => {
    expect(parseZoomLevel(null)).toBe(100);
    expect(parseZoomLevel("abc")).toBe(100);
    expect(parseZoomLevel("")).toBe(100);
    expect(parseZoomLevel("  ")).toBe(100);
    expect(parseZoomLevel("120")).toBe(120);
    expect(parseZoomLevel("1000")).toBe(200);
  });
});
