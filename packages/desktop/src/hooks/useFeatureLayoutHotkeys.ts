import { useCallback } from "react";

import { useBrowserShortcutRelay } from "@/hooks/useBrowserShortcutRelay";
import { useShortcut } from "@/hooks/useShortcut";
import { type BrowserShortcut } from "@/lib/desktop-bridge";
import { activateFeatureTab } from "@/stores/feature-layout-store";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import type { TabKind } from "@/stores/feature-layout-schema";
import type { FeatureTabActivationHandlers } from "@/components/feature-layout/types";

type FeatureLayoutHotkeysOptions = FeatureTabActivationHandlers & { enabled?: boolean };

// Pane chords relayed from a focused browser guest page → the tab they select.
// A native WebContentsView swallows keydown before the renderer sees it, so
// ⌘⇧A/T/G/E/B are forwarded from the main process (see `browser-tab-events.ts`).
const PANE_BY_SHORTCUT: Partial<Record<BrowserShortcut, TabKind>> = {
  "pane-agent": "agent",
  "pane-terminal": "terminal",
  "pane-git": "git",
  "pane-editor": "editor",
  "pane-browser": "browser",
};

/**
 * Preserves the existing Mod+Shift+A/T/G/E shortcuts. Each hotkey:
 *   1. Locates the pane currently hosting the requested tab.
 *   2. Sets that pane's active tab.
 *   3. Records the pane as `focusedPaneId` so the renderer can give it focus.
 *
 * If the tab isn't placed yet (shouldn't happen — every tab is always in
 * exactly one pane), the hotkey is a no-op rather than crashing.
 */
export function useFeatureLayoutHotkeys(
  featureId: number,
  options: FeatureLayoutHotkeysOptions = {},
): void {
  const { onTerminalActivate, onEditorActivate, enabled = true } = options;

  const activate = useCallback(
    (tab: TabKind) => {
      if (!activateFeatureTab(featureId, tab)) return;
      noteUserLayoutChange(featureId);
      if (tab === "terminal") onTerminalActivate?.();
      if (tab === "editor") onEditorActivate?.();
    },
    [featureId, onTerminalActivate, onEditorActivate],
  );

  useShortcut(
    "pane-agent",
    (e) => {
      e.preventDefault();
      activate("agent");
    },
    { enabled },
  );
  useShortcut(
    "pane-terminal",
    (e) => {
      e.preventDefault();
      activate("terminal");
    },
    { enabled },
  );
  useShortcut(
    "pane-git",
    (e) => {
      e.preventDefault();
      activate("git");
    },
    { enabled },
  );
  useShortcut(
    "pane-editor",
    (e) => {
      e.preventDefault();
      activate("editor");
    },
    { enabled },
  );
  useShortcut(
    "pane-browser",
    (e) => {
      e.preventDefault();
      activate("browser");
    },
    { enabled },
  );

  // Relay path: when a browser guest page holds keyboard focus the renderer's
  // window never sees ⌘⇧A/T/G/E/B, so the main process forwards them. Only the
  // active feature (hotkeys enabled) reacts, since the relay carries no scope.
  useBrowserShortcutRelay((shortcut: BrowserShortcut) => {
    if (!enabled) return;
    const tab = PANE_BY_SHORTCUT[shortcut];
    if (tab) activate(tab);
  });
}
