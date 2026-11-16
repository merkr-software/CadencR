// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopLevelSpec } from "vega-lite";
import { fitsContainerWidth, parseVegaLiteSpec, renderVegaLite } from "./vega-chart";

const BAR: TopLevelSpec = {
  data: {
    values: [
      { a: "x", b: 3 },
      { a: "y", b: 5 },
    ],
  },
  mark: "bar",
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
};

describe("parseVegaLiteSpec", () => {
  it("accepts a JSON object", () => {
    expect(parseVegaLiteSpec('{"mark": "bar"}')).toEqual({ ok: true, spec: { mark: "bar" } });
  });

  it("explains invalid JSON and non-object specs", () => {
    const invalid = parseVegaLiteSpec('{"mark": "bar",}');
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toMatch(/^Invalid JSON/);
    expect(parseVegaLiteSpec("[1, 2]")).toEqual({
      ok: false,
      error: "A Vega-Lite spec must be a JSON object.",
    });
  });
});

describe("fitsContainerWidth", () => {
  it("fills single and layered views that set no width", () => {
    expect(fitsContainerWidth(BAR)).toBe(true);
    expect(fitsContainerWidth({ layer: [] } as unknown as TopLevelSpec)).toBe(true);
  });

  it("leaves explicit widths and compositions alone", () => {
    expect(fitsContainerWidth({ ...BAR, width: 300 })).toBe(false);
    expect(fitsContainerWidth({ hconcat: [BAR, BAR] } as TopLevelSpec)).toBe(false);
  });
});

describe("renderVegaLite", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders SVG without generating code from strings", async () => {
    // The packaged renderer CSP has no 'unsafe-eval': expressions must be interpreted.
    const FunctionSpy = vi.spyOn(globalThis, "Function");
    const container = document.createElement("div");
    document.body.append(container);
    const view = await renderVegaLite(
      container,
      { ...BAR, transform: [{ calculate: "datum.b * 2", as: "c" }] },
      {},
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(FunctionSpy).not.toHaveBeenCalled();
    view.finalize();
  });

  it("refuses external data", async () => {
    const container = document.createElement("div");
    const spec = { ...BAR, data: { url: "https://example.com/data.json" } } as TopLevelSpec;
    await expect(renderVegaLite(container, spec, {})).rejects.toThrow(
      /cannot load external resources/,
    );
  });
});
