import type { CSSProperties } from "react";
import { ArrowUp, Check, ChevronDown } from "lucide-react";
import type { ThemeDefinition } from "@/lib/themes";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { KINDS } from "./kinds";
import { PluginMark } from "./PluginBits";

/**
 * A miniature Cadencr workspace — sidebar, tab strip, a thinking block, a diff,
 * the composer — painted with a theme's own token values, scoped to this box.
 * Without a verified document it is drawn in outline: the app's current theme
 * never stands in for colors we have not seen.
 */
export function ThemeStage({
  definition,
  className,
}: {
  definition?: ThemeDefinition | null;
  className?: string;
}): React.JSX.Element {
  const style = definition?.cssVars as CSSProperties | undefined;
  return (
    <div
      aria-hidden="true"
      className={cn("mp-stage", className)}
      data-unpainted={definition ? undefined : ""}
      style={style}
    >
      <div className="mp-stage-rail">
        <span className="mp-stage-row w-1/2" />
        <span className="mp-stage-row" data-active="" />
        <span className="mp-stage-row w-4/5" />
        <span className="mp-stage-row w-3/5" />
        <span className="mp-stage-row w-2/3" />
      </div>
      <div className="mp-stage-page">
        <div className="mp-stage-tabs">
          <span className="mp-stage-tab" data-active="" />
          <span className="mp-stage-tab" />
          <span className="mp-stage-tab" />
        </div>
        <div className="mp-stage-block" data-kind="thinking">
          <span className="mp-stage-line w-3/4" data-tone="thinking" />
          <span className="mp-stage-line w-1/2" data-tone="thinking" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="mp-stage-line w-11/12" />
          <span className="mp-stage-line w-2/3" />
        </div>
        <div className="mp-stage-block" data-kind="diff">
          <span className="mp-stage-line w-2/3" data-tone="code" />
          <span className="mp-stage-line w-1/2" data-tone="del" />
          <span className="mp-stage-line w-3/4" data-tone="add" />
        </div>
        <div className="mp-stage-composer">
          <span className="mp-stage-line w-2/5" />
          <span className="mp-stage-send" />
        </div>
      </div>
    </div>
  );
}

/**
 * Where a provider lives once installed: the composer, its agent picker open
 * upward with this provider selected. The neighbouring rows are deliberately
 * blank — Cadencr never claims which other agents a user has. `compact` is the
 * tile crop: the picker and the composer's control row only.
 */
export function ProviderStage({
  listing,
  compact = false,
}: {
  listing: MarketplaceListing;
  compact?: boolean;
}): React.JSX.Element {
  const version = listing.installed?.version ?? listing.recommended;
  return (
    <div
      aria-hidden="true"
      className={cn("mp-composer-stage", KINDS[listing.kind].tone)}
      data-compact={compact ? "" : undefined}
    >
      <div className="mp-menu">
        <div className="mp-menu-row" data-active="">
          <PluginMark listing={listing} size={compact ? 16 : 20} />
          <span className="min-w-0 flex-1 truncate font-medium">{listing.name}</span>
          {version && (
            <span className="font-mono text-[10.5px] text-muted-foreground">{version}</span>
          )}
          <Check className="size-3.5 shrink-0 text-primary" />
        </div>
        {(compact ? [0.55] : [0.6, 0.45]).map((width) => (
          <div key={width} className="mp-menu-row opacity-60">
            <span className="mp-menu-blank-mark" />
            <span className="mp-menu-blank-line" style={{ width: `${width * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mp-composer">
        {!compact && <span className="mp-composer-placeholder" />}
        <div className="flex items-center gap-2">
          <span className="mp-composer-picker">
            <PluginMark listing={listing} size={compact ? 14 : 16} />
            <span className="truncate">{listing.name}</span>
            <ChevronDown className="size-3 shrink-0 rotate-180 text-muted-foreground" />
          </span>
          <span className="mp-composer-send">
            <ArrowUp className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}
