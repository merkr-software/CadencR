import { describe, expect, it } from "vitest";
import type { VisualTheme } from "./live-theme";
import { vegaThemeConfig } from "./vega-theme";

// Node has no canvas, so colors pass through unresolved: the mapping is what's under test.
const THEME: VisualTheme = {
  key: "1",
  snapshot: {
    id: "cadencr-dark",
    appearance: "dark",
    tokens: {
      background: "#101010",
      foreground: "#eeeeee",
      "muted-foreground": "#999999",
      border: "#333333",
      "chart-1": "#2db47d",
      "chart-2": "#e07aa8",
      "chart-3": "#8fd16a",
      "chart-4": "#3398db",
      "chart-5": "#e3a33b",
    },
  },
  fontSans: '"Inter Variable", sans-serif',
  fontMono: "monospace",
};

describe("vegaThemeConfig", () => {
  it("maps chart chrome onto theme tokens", () => {
    const config = vegaThemeConfig(THEME);
    expect(config.background).toBe("transparent");
    expect(config.font).toBe('"Inter Variable", sans-serif');
    expect(config.axis).toMatchObject({
      labelColor: "#999999",
      gridColor: "#333333",
      domainColor: "#333333",
    });
    expect(config.title).toMatchObject({ color: "#eeeeee", fontSize: 13 });
  });

  it("uses the app's series order, then the neutral Other tone, as the categorical palette", () => {
    const config = vegaThemeConfig(THEME);
    // --chart-3 stays out: too close to --chart-1 (lib/chart-series.ts).
    expect(config.range).toEqual({
      category: ["#2db47d", "#3398db", "#e07aa8", "#e3a33b", "#999999"],
    });
    expect(config.mark).toEqual({ color: "#2db47d" });
  });
});
