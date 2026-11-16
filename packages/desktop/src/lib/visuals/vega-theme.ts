import type { Config } from "vega-lite";

import type { VisualTheme } from "./live-theme";
import { perTheme, resolveThemeColor, visualPalette } from "./theme-colors";

/** Chart chrome sizes, on DESIGN.md's type scale (11px labels, 13px titles). */
const LABEL_SIZE = 11;
const TITLE_SIZE = 13;

/**
 * Vega-Lite config that draws a chart in the live Cadencr theme: transparent
 * background, Inter, hairline `--border` axes and grid, `--muted-foreground`
 * labels, and the categorical palette. Agents leave styling out of the spec.
 */
export const vegaThemeConfig = perTheme((theme: VisualTheme): Config => {
  const color = (token: string) => resolveThemeColor(theme, token);
  const foreground = color("foreground");
  const muted = color("muted-foreground");
  const border = color("border");
  const palette = visualPalette(theme);
  const font = theme.fontSans || undefined;
  return {
    background: "transparent",
    // Vega's default 5px inset; matches the HTML visuals' 2px, so a chart's
    // title lines up with the conversation text.
    padding: 2,
    font,
    view: { stroke: null, continuousHeight: 240 },
    axis: {
      domainColor: border,
      tickColor: border,
      gridColor: border,
      gridOpacity: 0.6,
      labelColor: muted,
      titleColor: muted,
      labelFontSize: LABEL_SIZE,
      titleFontSize: LABEL_SIZE,
      titleFontWeight: 500,
      labelPadding: 4,
      titlePadding: 8,
    },
    // Vega-Lite turns discrete x labels vertical by default; level reads better
    // and overlapping labels are still thinned out.
    axisX: { labelAngle: 0, labelOverlap: true },
    legend: {
      labelColor: foreground,
      titleColor: muted,
      labelFontSize: LABEL_SIZE,
      titleFontSize: LABEL_SIZE,
      titleFontWeight: 500,
      symbolType: "circle",
    },
    header: {
      labelColor: foreground,
      titleColor: muted,
      labelFontSize: LABEL_SIZE,
      titleFontSize: LABEL_SIZE,
    },
    title: {
      color: foreground,
      subtitleColor: muted,
      fontSize: TITLE_SIZE,
      subtitleFontSize: LABEL_SIZE,
      fontWeight: 600,
      anchor: "start",
      offset: 10,
    },
    range: palette.length > 0 ? { category: palette } : undefined,
    mark: { color: palette[0] },
    text: { color: foreground },
    rule: { color: muted },
    arc: { stroke: color("background") },
  };
});
