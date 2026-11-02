import { useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";

import { useFeatureLayoutHotkeys } from "@/hooks/useFeatureLayoutHotkeys";
import { useFeatureLayoutHydration } from "@/hooks/useFeatureLayoutHydration";
import { useFeatureLayoutPersistence } from "@/hooks/useFeatureLayoutPersistence";
import { useAgentBrowserActivityListener } from "@/lib/auto-layout/agent-browser-activity";
import { useAutoLayoutTarget } from "@/lib/auto-layout/useAutoLayoutTarget";
import {
  getFocusedTab,
  isAgentAlone,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import { getPluginTabs, restrictLayoutToTabs } from "@/stores/feature-layout-tree";

import { DragChip } from "./DragChip";
import { useStableTabIds } from "./feature-tabs";
import { SplitTreeRenderer } from "./SplitTreeRenderer";
import { TabContentRegistry } from "./TabContentRegistry";
import type { DragSource, FeatureTabActivationHandlers, FeatureTabs } from "./types";
import { useFeatureDnd } from "./useFeatureDnd";

interface FeatureLayoutShellProps extends FeatureTabActivationHandlers {
  featureId: number;
  tabs: FeatureTabs;
  splitsEnabled?: boolean;
  hotkeysEnabled?: boolean;
  mountInactiveTabs?: boolean;
  /**
   * Extra controls for the root pane's trailing strip area, before the auto
   * layout toggle (the custom-tab "+" menu).
   */
  rootStripActions?: ReactNode;
}

/**
 * Top-level component consumed by ws-session. Owns:
 *   - DnD context (one per page) with sensors, collision detection, overlay.
 *   - Tab content registry (mounts every tab body once, portals it).
 *   - Layout hydration on mount (`useFeatureLayoutHydration`).
 *   - Keyboard shortcuts (preserves Mod+Shift+A/T/G/E).
 *   - Auto layout registration (splits only) and the agent browser listener.
 *   - The split-tree renderer.
 *
 * Renders from a *view* of the stored layout limited to the tabs `tabs`
 * defines (`restrictLayoutToTabs`): a placed plugin tab whose plugin is
 * unavailable is hidden but keeps its place in the store, so re-enabling the
 * plugin brings it back where it was. Store mutations act on the raw layout.
 */
export function FeatureLayoutShell({
  featureId,
  tabs,
  onTerminalActivate,
  onEditorActivate,
  splitsEnabled = true,
  hotkeysEnabled = true,
  mountInactiveTabs = true,
  rootStripActions,
}: FeatureLayoutShellProps): ReactNode {
  useFeatureLayoutHydration(featureId, { enabled: splitsEnabled });
  useFeatureLayoutPersistence(featureId, { enabled: splitsEnabled });
  useFeatureLayoutHotkeys(featureId, {
    onTerminalActivate,
    onEditorActivate,
    enabled: hotkeysEnabled,
  });
  const shellRef = useRef<HTMLDivElement>(null);
  useAutoLayoutTarget(featureId, shellRef, splitsEnabled);
  useAgentBrowserActivityListener();

  const layoutState = useFeatureLayoutStore(selectFeatureLayout(featureId));
  // Wherever splits are off (mobile, embedded cards) we substitute a flat
  // single-pane layout. That must be memoized: `selectFeatureLayout` returns a
  // referentially stable value (see its CAUTION note), but a fresh flat layout
  // per render would re-run `TabContentRegistry`'s pre-paint move effect and
  // re-arm its `setVisitedTabs` effect every render — which is what drove the
  // mobile "Maximum update depth exceeded" (#185) crash. See that component.
  const effectiveLayout = useMemo(
    () =>
      splitsEnabled
        ? layoutState
        : flatLayoutState(
            getFocusedTab(layoutState) ?? "agent",
            getPluginTabs(layoutState.splitRoot),
          ),
    [layoutState, splitsEnabled],
  );
  // Same #185 rule: the ids are identity-stable (callers rebuild `tabs` every
  // render), and the view is `effectiveLayout` itself when nothing is hidden.
  const availableTabIds = useStableTabIds(tabs);
  const visibleLayout = useMemo(
    () => restrictLayoutToTabs(effectiveLayout, new Set(availableTabIds)),
    [availableTabIds, effectiveLayout],
  );
  const splitRoot = visibleLayout.splitRoot;
  // The agent alone on screen, its pop panes folded: it gets margins (see
  // `[data-agent-solo]` in feature-panes.css). Any open split keeps every pixel.
  const agentSolo = isAgentAlone(visibleLayout);

  const [activeSource, setActiveSource] = useState<DragSource | null>(null);
  const dnd = useFeatureDnd({
    featureId,
    onDragStart: setActiveSource,
    onDragEnd: () => setActiveSource(null),
  });

  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={dnd.collisionDetection}
      onDragStart={dnd.handleDragStart}
      onDragEnd={dnd.handleDragEnd}
      onDragCancel={dnd.handleDragCancel}
    >
      <TabContentRegistry
        featureId={featureId}
        tabs={tabs}
        layoutState={visibleLayout}
        mountVisibleOnly={!mountInactiveTabs}
      />
      <div
        ref={shellRef}
        data-feature-layout-shell
        data-has-floating-pane={splitRoot.type === "split" ? "true" : undefined}
        data-agent-solo={agentSolo || undefined}
        className="relative h-full min-h-0 flex-1 overflow-hidden"
      >
        <SplitTreeRenderer
          featureId={featureId}
          node={splitRoot}
          path={[]}
          tabs={tabs}
          onTerminalActivate={onTerminalActivate}
          onEditorActivate={onEditorActivate}
          splitsEnabled={splitsEnabled}
          rootStripActions={rootStripActions}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeSource ? <DragChip tab={activeSource.tab} tabs={tabs} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
