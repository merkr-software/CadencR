import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  PanelBottomCloseIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  PanelTopCloseIcon,
  type LucideIcon,
} from "lucide-react";

import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LayoutLeaf, TabKind } from "@/stores/feature-layout-schema";
import type { SplitEdge } from "@/stores/feature-layout-tree";

import { FeatureTabIcon } from "./FeatureTabIcon";
import { TabTooltip } from "./PaneTabTriggers";
import type { FeatureTabs, PaneSlot } from "./types";
import { usePaneStripDrop } from "./use-pane-strip-drop";
import { axisLength } from "./use-pop-panel";

/**
 * Pop panes (`LayoutLeaf.pop`): a pane folded to its header along its split
 * edge until it takes focus, then expanded to its stored share, pushing its
 * sibling. It folds back as soon as another pane takes focus. On a top or
 * bottom edge the header is the pane's own tab strip; on a side, a rail.
 */

/** Edge of its split a pane sits on. */
function paneEdge(slot: PaneSlot): SplitEdge {
  if (slot.orientation === "horizontal") return slot.index === 0 ? "left" : "right";
  return slot.index === 0 ? "top" : "bottom";
}

const OPPOSITE_EDGE: Record<SplitEdge, SplitEdge> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

/**
 * While a pop pane slides in or out: its frame held at the open size and
 * pinned to the edge facing its sibling, so the moving panel uncovers it like
 * a drawer instead of squeezing it.
 */
export function slidingFrameStyle(slot: PaneSlot | undefined): CSSProperties | undefined {
  if (!slot || slot.slidingPx === null) return undefined;
  const facing = OPPOSITE_EDGE[paneEdge(slot)];
  if (slot.orientation === "horizontal") {
    return { position: "absolute", top: 0, bottom: 0, [facing]: 0, width: slot.slidingPx };
  }
  return { position: "absolute", left: 0, right: 0, [facing]: 0, height: slot.slidingPx };
}

const EDGE_ICONS: Record<SplitEdge, LucideIcon> = {
  left: PanelLeftCloseIcon,
  right: PanelRightCloseIcon,
  top: PanelTopCloseIcon,
  bottom: PanelBottomCloseIcon,
};

/** Tooltip placement pointing into the content the header sits beside. */
const TOOLTIP_PLACEMENTS = {
  left: { toRight: true },
  right: { toLeft: true },
  top: {},
  bottom: { above: true },
} as const satisfies Record<SplitEdge, object>;

interface PopPaneRailProps {
  paneId: string;
  leaf: LayoutLeaf;
  tabs: FeatureTabs;
  slot: PaneSlot;
  splitsEnabled: boolean;
  onActivateTab: (tab: TabKind) => void;
  onTogglePop: (pop: boolean) => void;
}

/**
 * Header of a folded pop pane on a left or right edge: the pane's strip turned
 * on its side, one icon per tab. A tab opens the pane on it; the rail is also
 * the pane's drop target, as its strip would be.
 */
export function PopPaneRail({
  paneId,
  leaf,
  tabs,
  slot,
  splitsEnabled,
  onActivateTab,
  onTogglePop,
}: PopPaneRailProps): ReactNode {
  const drop = usePaneStripDrop(paneId, splitsEnabled);
  const placement = TOOLTIP_PLACEMENTS[paneEdge(slot)];
  return (
    <div
      ref={drop.setNodeRef}
      data-pop-pane-rail
      className={cn(
        "flex h-full flex-col items-center gap-0.5 p-1 transition-colors",
        drop.showOver && "bg-primary/15",
      )}
    >
      {leaf.tabIds.map((tab) => {
        const def = tabs[tab];
        if (!def) return null;
        return (
          <TabTooltip key={tab} def={def} label={`Show ${def.label}`} placement={placement}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Show ${def.label}`}
              data-feature-tab-kind={tab}
              onClick={() => onActivateTab(tab)}
              className={cn(
                "size-7 text-muted-foreground hover:text-foreground",
                tab === leaf.activeTabId && "text-foreground",
              )}
            >
              <FeatureTabIcon def={def} />
            </Button>
          </TabTooltip>
        );
      })}
      <div className="mt-auto">
        <PopPaneToggle slot={slot} pop onToggle={onTogglePop} />
      </div>
    </div>
  );
}

/** Folded frame: as small as its header along the split axis. */
export function foldedFrameClass(slot: PaneSlot): string {
  return slot.orientation === "horizontal" ? "h-full w-max" : "h-max w-full";
}

/**
 * Reports a folded pop pane's header size along its split axis, so the panel
 * folds to exactly the header the theme draws (tab height, paddings).
 */
export function useReportFoldedSize(slot: PaneSlot | undefined): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const report = slot?.popCollapsed ? slot.onFoldedSize : undefined;
  const horizontal = slot?.orientation === "horizontal";
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !report) return;
    const measure = (): void => report(axisLength(el, horizontal));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [horizontal, report]);
  return ref;
}

interface PopPaneToggleProps {
  slot: PaneSlot;
  pop: boolean;
  onToggle: (pop: boolean) => void;
}

/** Strip button that turns a floating pane into a pop pane, or pins it open again. */
export function PopPaneToggle({ slot, pop, onToggle }: PopPaneToggleProps): ReactNode {
  const Icon = EDGE_ICONS[paneEdge(slot)];
  const label = pop
    ? "Pop pane: shown only while focused. Click to keep it open"
    : "Pop pane: fold to its header until focused";
  return (
    <ShortcutTooltip label={label} alignRight>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Pop pane"
        aria-pressed={pop}
        onClick={() => onToggle(!pop)}
        className={cn(
          "size-7",
          pop && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        <Icon className="size-4" />
      </Button>
    </ShortcutTooltip>
  );
}
