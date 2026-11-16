import { useEffect, useRef } from "react";

/**
 * Mount-time effects of the feature Editor tab: seed the per-feature editor
 * state, restore editor focus when the tab regains it, and apply the persisted
 * file-tree preference once.
 */
export function useFeatureEditorEffects({
  focus,
  initFeature,
  isEditorFocused,
  persistedCollapsed,
  sidebarVisible,
  sidebarAutoHidden,
  toggleSidebar,
}: {
  focus: { shouldRestoreEditorFocus: () => boolean; focusActiveEditor: () => void };
  initFeature: () => void;
  isEditorFocused: boolean;
  persistedCollapsed: string | null;
  sidebarVisible: boolean;
  sidebarAutoHidden: boolean;
  toggleSidebar: () => void;
}): void {
  const initializedRef = useRef(false);
  useEffect(() => initFeature(), [initFeature]);
  useEffect(() => {
    if (!isEditorFocused || !focus.shouldRestoreEditorFocus()) return undefined;
    const frame = requestAnimationFrame(focus.focusActiveEditor);
    return () => cancelAnimationFrame(frame);
  }, [focus, isEditorFocused]);
  useEffect(() => {
    if (initializedRef.current || persistedCollapsed === null) return;
    initializedRef.current = true;
    // Auto layout hid the tree for a pane beside the agent; don't reopen it.
    if (sidebarAutoHidden) return;
    if ((persistedCollapsed !== "true") !== sidebarVisible) toggleSidebar();
  }, [persistedCollapsed, sidebarAutoHidden, sidebarVisible, toggleSidebar]);
}
