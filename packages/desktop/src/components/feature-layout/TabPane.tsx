import { useCallback, useRef, type ReactNode } from "react";
import { ROOT_LEAF_ID, type LayoutLeaf, type TabKind } from "@/stores/feature-layout-schema";
import {
  getFocusedLeaf,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { makeTabHostKey, useTabHostRegistry } from "@/stores/tab-host-registry";
import { useFreezeWidthDuringResize } from "@/lib/use-freeze-width-during-resize";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import { PaneChrome } from "./PaneChrome";
import type { FeatureTabActivationHandlers, FeatureTabs } from "./types";

interface TabPaneProps extends FeatureTabActivationHandlers {
  featureId: number;
  leaf: LayoutLeaf;
  tabs: FeatureTabs;
  splitsEnabled?: boolean;
}

/**
 * One pane in the split grid. Owns:
 *   - A line-style tab strip (shadcn Tabs).
 *   - A content host `<div>` registered into `tab-host-registry` so portals
 *     can target it.
 *   - 5 drop zones (4 edges + 1 center) overlaid on the content area when a
 *     drag is active. Each zone is a `useDroppable` with edge metadata.
 *   - For the root pane, the LayoutMenu trailing the strip.
 */
export function TabPane({
  featureId,
  leaf,
  tabs,
  onTerminalActivate,
  onEditorActivate,
  splitsEnabled = true,
}: TabPaneProps): ReactNode {
  const registerHost = useTabHostRegistry((s) => s.registerHost);
  const unregisterHost = useTabHostRegistry((s) => s.unregisterHost);
  const setPaneActiveTab = useFeatureLayoutStore((s) => s.setPaneActiveTab);
  const dockTab = useFeatureLayoutStore((s) => s.dockTab);
  const setFocusedPane = useFeatureLayoutStore((s) => s.setFocusedPane);
  const focusedPaneId = useFeatureLayoutStore(
    (s) => getFocusedLeaf(selectFeatureLayout(featureId)(s))?.id ?? ROOT_LEAF_ID,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const hostKey = makeTabHostKey(featureId, leaf.id);
  const markPaneFocused = useCallback((): void => {
    setFocusedPane(featureId, leaf.id);
  }, [featureId, leaf.id, setFocusedPane]);

  // Tab-resize perf: lock the pane's content host width for the duration of
  // any panel-resize drag. This single freeze covers every tab (terminal,
  // editor, agent, diff) because their roots fill the host, so they inherit
  // the locked width and skip per-pointer-move reflow. Without this, dragging
  // the global sidebar would still feel sluggish whenever the pane held heavy
  // content (xterm, dozens of CodeMirror instances in a diff, etc.) — the
  // AgentStream-only freeze covered just one tab kind.
  const freezeWidthRef = useFreezeWidthDuringResize<HTMLDivElement>();

  const setContentRef = useCallback(
    (el: HTMLDivElement | null): (() => void) | undefined => {
      freezeWidthRef.current = el;
      if (!el) return undefined;
      registerHost(hostKey, el);
      el.addEventListener("pointerdown", markPaneFocused, { capture: true });
      el.addEventListener("focusin", markPaneFocused, { capture: true });
      return () => {
        freezeWidthRef.current = null;
        el.removeEventListener("pointerdown", markPaneFocused, { capture: true });
        el.removeEventListener("focusin", markPaneFocused, { capture: true });
        unregisterHost(hostKey, el);
      };
    },
    // `freezeWidthRef` is a stable ref object — intentionally omitted from deps.
    [hostKey, markPaneFocused, registerHost, unregisterHost],
  );

  const isRoot = leaf.id === ROOT_LEAF_ID;
  const isFocused = focusedPaneId === leaf.id;
  const activatedTabRef = useRef<TabKind | null>(null);

  const notifyTabActivation = useCallback(
    (tab: TabKind): void => {
      if (tab === "terminal") onTerminalActivate?.();
      if (tab === "editor") onEditorActivate?.();
    },
    [onEditorActivate, onTerminalActivate],
  );

  const activateTab = useCallback(
    (tab: TabKind): void => {
      markPaneFocused();
      if (activatedTabRef.current === tab) return;
      activatedTabRef.current = tab;
      queueMicrotask(() => {
        if (activatedTabRef.current === tab) activatedTabRef.current = null;
      });
      // Re-clicking the tab already showing isn't arranging anything, so it
      // must not hold off the agent's next reveal.
      if (leaf.activeTabId !== tab) {
        noteUserLayoutChange(featureId);
        setPaneActiveTab(featureId, leaf.id, tab);
      }
      notifyTabActivation(tab);
    },
    [featureId, leaf.activeTabId, leaf.id, markPaneFocused, notifyTabActivation, setPaneActiveTab],
  );

  const handleTabChange = useCallback(
    (value: string): void => {
      activateTab(value as TabKind);
    },
    [activateTab],
  );

  return (
    <PaneChrome
      featureId={featureId}
      leaf={leaf}
      tabs={tabs}
      isRoot={isRoot}
      isFocused={isFocused}
      splitsEnabled={splitsEnabled}
      containerRef={containerRef}
      contentRef={setContentRef}
      onFocusPane={markPaneFocused}
      onTabChange={handleTabChange}
      onActivateTab={activateTab}
      onDockTab={(tab) => {
        noteUserLayoutChange(featureId, { structural: true });
        dockTab(featureId, tab);
      }}
    />
  );
}
