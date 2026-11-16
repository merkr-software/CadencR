import { memo, useMemo, type CSSProperties, type ReactElement } from "react";
import { PuzzleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** SVG markup as a CSS mask, so the icon takes the surrounding text color. */
function svgMaskStyle(svg: string): CSSProperties {
  return {
    maskImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`,
    maskSize: "contain",
    maskRepeat: "no-repeat",
    maskPosition: "center",
  };
}

/**
 * A custom tab's manifest icon, painted as a CSS mask over `currentColor` so
 * it follows the theme and the trigger's active/hover color like a lucide
 * glyph. The SVG is the author's, never inserted as markup. Falls back to
 * the Puzzle glyph when the tab has no icon.
 */
export const PluginTabIcon = memo(function PluginTabIcon({
  svg,
  className,
  "data-testid": testId,
}: {
  svg: string | null | undefined;
  className?: string;
  "data-testid"?: string;
}): ReactElement {
  const style = useMemo(() => (svg ? svgMaskStyle(svg) : null), [svg]);
  if (!style) return <PuzzleIcon aria-hidden className={cn("size-4 shrink-0", className)} />;
  return (
    <span
      aria-hidden
      data-plugin-tab-icon
      data-testid={testId}
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={style}
    />
  );
});
