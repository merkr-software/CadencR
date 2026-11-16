import type { NotchGeometry, NotchPrimaryStyle } from "@/shared/notch";

export type IslandMode = "idle" | "compact" | "peek" | "expanded";

export interface IslandSize {
  width: number;
  height: number;
}

interface BodyHeights {
  peek: number;
  panel: number;
}

export const EAR_WIDTH = 56;
const PEEK_WIDTH = 440;
const PANEL_WIDTH = 540;
const RADII: Record<IslandMode, number> = { idle: 10, compact: 13, peek: 24, expanded: 28 };
const ACTIVITY_STRIP_WIDTH_SCALE = 0.5;

export function isStripStyle(style: NotchPrimaryStyle): style is "strip_4" | "strip_8" {
  return style === "strip_4" || style === "strip_8";
}

export function islandRadius(mode: IslandMode, style: NotchPrimaryStyle): number {
  if (isStripStyle(style) && (mode === "idle" || mode === "compact")) {
    return style === "strip_4" ? 2 : 4;
  }
  return RADII[mode];
}

export function islandSize(
  mode: IslandMode,
  geometry: NotchGeometry,
  bodies: BodyHeights,
  style: NotchPrimaryStyle,
): IslandSize {
  const { notchWidth, notchHeight } = geometry;
  if (mode === "idle" || mode === "compact") {
    if (style === "none") return { width: 0, height: 0 };
    if (isStripStyle(style)) {
      return {
        width: Math.min(
          geometry.windowWidth - 24,
          (geometry.compactWidth ?? notchWidth) * ACTIVITY_STRIP_WIDTH_SCALE,
        ),
        height: style === "strip_4" ? 4 : 8,
      };
    }
  }
  switch (mode) {
    case "idle":
      return { width: notchWidth, height: notchHeight };
    case "compact":
      return { width: notchWidth + EAR_WIDTH * 2, height: notchHeight };
    case "peek":
      return { width: Math.max(PEEK_WIDTH, notchWidth + 200), height: notchHeight + bodies.peek };
    case "expanded":
      return {
        width: Math.max(PANEL_WIDTH, notchWidth + 300),
        height: Math.min(geometry.windowHeight - 24, notchHeight + bodies.panel),
      };
  }
}
