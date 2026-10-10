import { type ReactNode, type RefObject } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { XIcon } from "lucide-react";

import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { LayoutLeaf, TabKind } from "@/stores/feature-layout-schema";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";
import { cn } from "@/lib/utils";

import { AutoLayoutToggle } from "./AutoLayoutToggle";
import { LayoutMenu } from "./LayoutMenu";
import type { DragSource, FeatureTabs } from "./types";

interface PaneChromeProps {
  featureId: number;
  leaf: LayoutLeaf;
  tabs: FeatureTabs;
  isRoot: boolean;
  isFocused: boolean;
  splitsEnabled: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: (el: HTMLDivElement | null) => (() => void) | undefined;
  onFocusPane: () => void;
  onTabChange: (value: string) => void;
  onActivateTab: (tab: TabKind) => void;
  onDockTab: (tab: TabKind) => void;
}

export function PaneChrome({
  featureId,
  leaf,
  tabs,
  isRoot,
  isFocused,
  splitsEnabled,
  containerRef,
  contentRef,
  onFocusPane,
  onTabChange,
  onActivateTab,
  onDockTab,
}: PaneChromeProps): ReactNode {
  const autoRevealed = useAutoLayoutStore((s) =>
    s.revealed[featureId]?.paneId === leaf.id ? s.revealed[featureId].kind : undefined,
  );
  return (
    <div
      // `data-pane-frame` lets CadencR themes equalize the floating-pane gutter
      // (the default `px-1.5 pb-1.5` has no top padding). Other themes ignore it.
      data-pane-frame={isRoot ? "root" : "floating"}
      className={cn("h-full w-full", isRoot ? "pt-px" : "px-1.5 pb-1.5")}
    >
      <div
        ref={containerRef}
        data-pane-id={leaf.id}
        data-pane-root={isRoot || undefined}
        data-pane-focused={isFocused}
        data-auto-revealed={autoRevealed}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget || !autoRevealed) return;
          useAutoLayoutStore.getState().clearRevealed(featureId, leaf.id);
        }}
        className={cn(
          "relative flex h-full w-full flex-col bg-background outline-none",
          !isRoot && "overflow-hidden rounded-lg border border-border shadow-md",
        )}
        onPointerDownCapture={onFocusPane}
        onFocusCapture={onFocusPane}
      >
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
          />
          {isRoot && splitsEnabled && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
              <AutoLayoutToggle featureId={featureId} />
              <LayoutMenu featureId={featureId} />
            </div>
          )}
        </PaneTabStrip>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={contentRef} className="h-full w-full" />
          {splitsEnabled && <PaneEdgeDropZones paneId={leaf.id} />}
        </div>
      </div>
    </div>
  );
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
}: PaneTabsProps): ReactNode {
  return (
    <Tabs
      value={leaf.activeTabId ?? ""}
      onValueChange={onTabChange}
      className="flex min-w-0 flex-1"
    >
      <TabsList className="flex-1 overflow-x-auto overflow-y-hidden border-b-0">
        {leaf.tabIds.length === 0 && (
          <span className="px-3 py-2 text-xs italic text-muted-foreground">Drag tabs here</span>
        )}
        {leaf.tabIds.map((tab) =>
          splitsEnabled ? (
            <DraggableTabTrigger
              key={tab}
              featureId={featureId}
              paneId={leaf.id}
              tab={tab}
              tabs={tabs}
              isRootPane={isRoot}
              isFocusedPane={isFocused}
              onActivate={() => onActivateTab(tab)}
              onClose={() => {
                if (isRoot) return;
                onDockTab(tab);
              }}
            />
          ) : (
            <StaticTabTrigger
              key={tab}
              featureId={featureId}
              tab={tab}
              tabs={tabs}
              isFocusedPane={isFocused}
              onActivate={() => onActivateTab(tab)}
            />
          ),
        )}
      </TabsList>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Draggable tab trigger
// ---------------------------------------------------------------------------

interface DraggableTabTriggerProps {
  featureId: number;
  paneId: string;
  tab: TabKind;
  tabs: FeatureTabs;
  isRootPane: boolean;
  isFocusedPane: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function DraggableTabTrigger({
  featureId,
  paneId,
  tab,
  tabs,
  isRootPane,
  isFocusedPane,
  onActivate,
  onClose,
}: DraggableTabTriggerProps): ReactNode {
  const def = tabs[tab];
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `tab:${paneId}:${tab}`,
    data: { kind: "pane", paneId, tab } as const,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.4 : undefined,
      }}
      className="relative inline-flex shrink-0"
    >
      <ShortcutTooltip label={def.label} keys={def.shortcut}>
        <TabsTrigger
          value={tab}
          data-feature-tab-kind={tab}
          data-feature-id={featureId}
          {...attributes}
          {...listeners}
          onClick={onActivate}
          className={cn(
            "cursor-grab active:cursor-grabbing",
            !isRootPane && "pr-8",
            !isFocusedPane && "data-[state=active]:after:bg-transparent",
          )}
        >
          <def.Icon className="size-4 shrink-0" />
          <span>{def.label}</span>
          {def.badge}
        </TabsTrigger>
      </ShortcutTooltip>
      {!isRootPane && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={`Return ${def.label} to the root tab strip`}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

interface StaticTabTriggerProps {
  featureId: number;
  tab: TabKind;
  tabs: FeatureTabs;
  isFocusedPane: boolean;
  onActivate: () => void;
}

function StaticTabTrigger({
  featureId,
  tab,
  tabs,
  isFocusedPane,
  onActivate,
}: StaticTabTriggerProps): ReactNode {
  const def = tabs[tab];
  return (
    <ShortcutTooltip label={def.label} keys={def.shortcut}>
      <TabsTrigger
        value={tab}
        data-feature-tab-kind={tab}
        data-feature-id={featureId}
        onClick={onActivate}
        className={cn("group", !isFocusedPane && "data-[state=active]:after:bg-transparent")}
      >
        <def.Icon className="size-4 shrink-0" />
        <span>{def.label}</span>
        {def.badge}
      </TabsTrigger>
    </ShortcutTooltip>
  );
}

// ---------------------------------------------------------------------------
// Drop zones
// ---------------------------------------------------------------------------

/**
 * The pane's tab bar is itself the "merge into this pane" drop target. Drop a
 * dragged tab anywhere on the strip and it gets appended to this pane's tab
 * list — that's the natural gesture (matches how browsers move tabs between
 * windows). The strip only highlights when the source is *another* pane, so
 * dragging a tab over its own strip stays visually quiet.
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
  const droppable = useDroppable({
    id: `strip:${paneId}`,
    data: { kind: "pane-strip", paneId } as const,
    disabled: !enabled,
  });
  const sourcePaneId = (droppable.active?.data.current as DragSource | undefined)?.paneId;
  const showOver =
    enabled && droppable.isOver && sourcePaneId !== undefined && sourcePaneId !== paneId;
  return (
    <div
      ref={enabled ? droppable.setNodeRef : undefined}
      data-pane-tab-strip
      className={cn(
        "flex shrink-0 items-stretch border-b border-border transition-colors",
        showOver && "bg-primary/15",
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
