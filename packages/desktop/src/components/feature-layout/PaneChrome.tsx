import { useEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { useDroppable } from "@dnd-kit/core";

import { Tabs, TabsList } from "@/components/ui/tabs";
import type { LayoutLeaf, TabKind } from "@/stores/feature-layout-schema";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";
import { cn } from "@/lib/utils";

import { AutoLayoutToggle } from "./AutoLayoutToggle";
import { LayoutMenu } from "./LayoutMenu";
import { DraggableTabTrigger, StaticTabTrigger, tabCloseAction } from "./PaneTabTriggers";
import {
  foldedFrameClass,
  PopPaneRail,
  PopPaneToggle,
  slidingFrameStyle,
  useReportFoldedSize,
} from "./pop-pane";
import type { FeatureTabs, PaneSlot } from "./types";
import { usePaneStripDrop } from "./use-pane-strip-drop";

export interface PaneChromeProps {
  featureId: number;
  leaf: LayoutLeaf;
  tabs: FeatureTabs;
  isRoot: boolean;
  isFocused: boolean;
  splitsEnabled: boolean;
  /** Root pane only: extra controls trailing the strip, before AutoLayoutToggle. */
  stripActions?: ReactNode;
  /** Where the pane sits in its parent split; absent for a lone root pane. */
  slot?: PaneSlot;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: (el: HTMLDivElement | null) => (() => void) | undefined;
  onFocusPane: () => void;
  onTabChange: (value: string) => void;
  onActivateTab: (tab: TabKind) => void;
  onDockTab: (tab: TabKind) => void;
  /** Take a closable (plugin) tab out of the layout. */
  onCloseTab: (tab: TabKind) => void;
  /** Make the pane a pop pane, or pin it open again. */
  onTogglePop: (pop: boolean) => void;
}

export function PaneChrome({
  featureId,
  leaf,
  tabs,
  isRoot,
  isFocused,
  splitsEnabled,
  stripActions,
  slot,
  containerRef,
  contentRef,
  onFocusPane,
  onTabChange,
  onActivateTab,
  onDockTab,
  onCloseTab,
  onTogglePop,
}: PaneChromeProps): ReactNode {
  const popCollapsed = slot?.popCollapsed ?? false;
  const rail = popCollapsed && slot?.orientation === "horizontal";
  const frameRef = useReportFoldedSize(slot);
  const autoRevealed = useAutoLayoutStore((s) =>
    s.revealed[featureId]?.paneId === leaf.id ? s.revealed[featureId].kind : undefined,
  );
  return (
    <div
      ref={frameRef}
      // `data-pane-frame` lets CadencR themes equalize the floating-pane gutter
      // (the default `px-1.5 pb-1.5` has no top padding). Other themes ignore it.
      data-pane-frame={isRoot ? "root" : "floating"}
      className={cn(
        popCollapsed && slot ? foldedFrameClass(slot) : "h-full w-full",
        isRoot ? "pt-px" : "px-1.5 pb-1.5",
      )}
      style={slidingFrameStyle(slot)}
    >
      <div
        ref={containerRef}
        data-pane-id={leaf.id}
        data-pane-root={isRoot || undefined}
        data-pane-focused={isFocused}
        data-pop-folded={popCollapsed || undefined}
        data-auto-revealed={autoRevealed}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget || !autoRevealed) return;
          useAutoLayoutStore.getState().clearRevealed(featureId, leaf.id);
        }}
        className={cn(
          "relative flex h-full w-full flex-col bg-background outline-none",
          !isRoot && "overflow-hidden rounded-lg border border-border shadow-md",
        )}
        {...paneFocusHandlers(popCollapsed, onFocusPane)}
      >
        {rail && slot ? (
          <PopPaneRail
            paneId={leaf.id}
            leaf={leaf}
            tabs={tabs}
            slot={slot}
            splitsEnabled={splitsEnabled}
            onActivateTab={onActivateTab}
            onTogglePop={onTogglePop}
          />
        ) : (
          <PaneTabStrip paneId={leaf.id} enabled={splitsEnabled}>
            <PaneTabs
              featureId={featureId}
              leaf={leaf}
              tabs={tabs}
              isRoot={isRoot}
              isFocused={isFocused}
              splitsEnabled={splitsEnabled}
              onTabChange={onTabChange}
              onActivateTab={onActivateTab}
              onDockTab={onDockTab}
              onCloseTab={onCloseTab}
            />
            {isRoot && (splitsEnabled || stripActions) && (
              <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
                {stripActions}
                {splitsEnabled && <AutoLayoutToggle featureId={featureId} />}
                {splitsEnabled && <LayoutMenu featureId={featureId} />}
              </div>
            )}
            {!isRoot && splitsEnabled && slot && (
              <div data-pop-toggle-slot className="ml-auto flex shrink-0 items-center pr-1">
                <PopPaneToggle slot={slot} pop={slot.pops} onToggle={onTogglePop} />
              </div>
            )}
          </PaneTabStrip>
        )}
        <PaneBody
          paneId={leaf.id}
          hidden={popCollapsed}
          splitsEnabled={splitsEnabled}
          contentRef={contentRef}
        />
      </div>
    </div>
  );
}

/**
 * The tab content host. A folded pop pane's body stays mounted (its host keeps
 * the tab content) but hidden, so the content sees no size and skips reflowing.
 */
function PaneBody({
  paneId,
  hidden,
  splitsEnabled,
  contentRef,
}: {
  paneId: string;
  hidden: boolean;
  splitsEnabled: boolean;
  contentRef: PaneChromeProps["contentRef"];
}): ReactNode {
  return (
    <div
      data-pane-body
      className={cn("relative min-h-0 flex-1 overflow-hidden", hidden && "hidden")}
    >
      <div ref={contentRef} className="h-full w-full" />
      {splitsEnabled && <PaneEdgeDropZones paneId={paneId} />}
    </div>
  );
}

/**
 * A press or focus inside the pane focuses it. A folded pop pane's header
 * opens on the click instead, once the click has reached its button: the
 * header moves (or turns from rail to strip) as the pane opens, and React
 * renders that between an event's capture and bubble passes. (A strip's tab
 * trigger still opens the pane on press, as it activates its tab then.)
 */
function paneFocusHandlers(
  popCollapsed: boolean,
  onFocusPane: () => void,
): Pick<HTMLAttributes<HTMLDivElement>, "onPointerDownCapture" | "onFocusCapture" | "onClick"> {
  if (popCollapsed) return { onClick: onFocusPane };
  return { onPointerDownCapture: onFocusPane, onFocusCapture: onFocusPane };
}

interface PaneTabsProps {
  featureId: number;
  leaf: LayoutLeaf;
  tabs: FeatureTabs;
  isRoot: boolean;
  isFocused: boolean;
  splitsEnabled: boolean;
  onTabChange: (value: string) => void;
  onActivateTab: (tab: TabKind) => void;
  onDockTab: (tab: TabKind) => void;
  onCloseTab: (tab: TabKind) => void;
}

function PaneTabs({
  featureId,
  leaf,
  tabs,
  isRoot,
  isFocused,
  splitsEnabled,
  onTabChange,
  onActivateTab,
  onDockTab,
  onCloseTab,
}: PaneTabsProps): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  // Custom tab triggers appear once their definitions load, after the layout.
  const renderedTabCount = leaf.tabIds.filter((tab) => tabs[tab]).length;
  useRevealActiveTab(listRef, leaf.activeTabId, renderedTabCount);
  return (
    <Tabs
      value={leaf.activeTabId ?? ""}
      onValueChange={onTabChange}
      className="flex min-w-0 flex-1"
    >
      <TabsList ref={listRef} className="flex-1 overflow-x-auto overflow-y-hidden border-b-0">
        {leaf.tabIds.length === 0 && (
          <span className="px-3 py-2 text-xs italic text-muted-foreground">Drag tabs here</span>
        )}
        {leaf.tabIds.map((tab) => {
          // The shell renders a view without unavailable tabs; stay defensive.
          const def = tabs[tab];
          if (!def) return null;
          // With splits off the only pane is the root: nothing to dock.
          const closeAction = tabCloseAction(def, isRoot || !splitsEnabled);
          const onClose = (): void => {
            if (closeAction === "close") onCloseTab(tab);
            else if (closeAction === "dock") onDockTab(tab);
          };
          return splitsEnabled ? (
            <DraggableTabTrigger
              key={tab}
              featureId={featureId}
              paneId={leaf.id}
              tab={tab}
              def={def}
              closeAction={closeAction}
              isFocusedPane={isFocused}
              onActivate={() => onActivateTab(tab)}
              onClose={onClose}
            />
          ) : (
            <StaticTabTrigger
              key={tab}
              featureId={featureId}
              tab={tab}
              def={def}
              closeAction={closeAction}
              isFocusedPane={isFocused}
              onActivate={() => onActivateTab(tab)}
              onClose={onClose}
            />
          );
        })}
      </TabsList>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Drop zones
// ---------------------------------------------------------------------------

/**
 * The pane's tab bar is itself the "merge into this pane" drop target. Drop a
 * dragged tab anywhere on the strip and it gets appended to this pane's tab
 * list — that's the natural gesture (matches how browsers move tabs between
 * windows).
 */
function PaneTabStrip({
  paneId,
  enabled,
  children,
}: {
  paneId: string;
  enabled: boolean;
  children: ReactNode;
}): ReactNode {
  const drop = usePaneStripDrop(paneId, enabled);
  return (
    <div
      ref={drop.setNodeRef}
      data-pane-tab-strip
      className={cn(
        "flex shrink-0 items-stretch border-b border-border transition-colors",
        drop.showOver && "bg-primary/15",
      )}
    >
      {children}
    </div>
  );
}

function PaneEdgeDropZones({ paneId }: { paneId: string }): ReactNode {
  return (
    <>
      <EdgeDropZone paneId={paneId} edge="top" />
      <EdgeDropZone paneId={paneId} edge="right" />
      <EdgeDropZone paneId={paneId} edge="bottom" />
      <EdgeDropZone paneId={paneId} edge="left" />
    </>
  );
}

const EDGE_THICKNESS = "30%";

function EdgeDropZone({
  paneId,
  edge,
}: {
  paneId: string;
  edge: "top" | "right" | "bottom" | "left";
}): ReactNode {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `edge:${paneId}:${edge}`,
    data: { kind: "pane-edge", paneId, edge } as const,
  });
  if (!active) return null;
  // Thin strip along the matching edge, only active during a drag.
  const positional = {
    top: { top: 0, left: 0, right: 0, height: EDGE_THICKNESS },
    bottom: { bottom: 0, left: 0, right: 0, height: EDGE_THICKNESS },
    left: { top: 0, bottom: 0, left: 0, width: EDGE_THICKNESS },
    right: { top: 0, bottom: 0, right: 0, width: EDGE_THICKNESS },
  }[edge];
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      style={positional}
      className={cn(
        "pointer-events-auto absolute z-20 transition-colors",
        isOver ? "bg-primary/40" : "bg-transparent",
      )}
    />
  );
}

/**
 * Keep the active tab inside a strip that overflows horizontally — a custom tab
 * added from the "+" menu lands at the end, often past the visible edge. Reads
 * layout only when the active tab or the tab count changes.
 */
function useRevealActiveTab(
  listRef: RefObject<HTMLDivElement | null>,
  activeTabId: TabKind | null,
  tabCount: number,
): void {
  useEffect(() => {
    const list = listRef.current;
    const target = list && activeTabId ? activeTabTarget(list, activeTabId) : null;
    if (!list || !target) return;
    // Tab widths settle after fonts and badges load (any tab before it can
    // push it out), so follow every tab's size while this one is active.
    const reveal = (): void => revealInStrip(list, target);
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [activeTabId, listRef, tabCount]);
}

/** The active trigger's wrapper, which also holds its close button. */
function activeTabTarget(list: HTMLElement, activeTabId: TabKind): HTMLElement | null {
  const trigger = Array.from(list.querySelectorAll<HTMLElement>("[data-feature-tab-kind]")).find(
    (element) => element.dataset.featureTabKind === activeTabId,
  );
  if (!trigger) return null;
  return trigger.parentElement && trigger.parentElement !== list ? trigger.parentElement : trigger;
}

function revealInStrip(list: HTMLElement, target: HTMLElement): void {
  if (list.scrollWidth <= list.clientWidth) return;
  const listBox = list.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  if (box.left < listBox.left) list.scrollLeft -= listBox.left - box.left;
  else if (box.right > listBox.right) list.scrollLeft += box.right - listBox.right;
}
