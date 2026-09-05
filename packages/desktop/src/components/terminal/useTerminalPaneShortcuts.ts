import type { RefObject } from "react";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import type { SplitOrientation } from "@/hooks/useTerminalState";
import type { TerminalCoreInstanceHandle } from "@/components/terminal-core";

interface UseTerminalPaneShortcutsParams {
  hotkeysEnabled: boolean;
  resolvedActivePaneId: string | null;
  paneRefs: RefObject<Map<string, TerminalCoreInstanceHandle>>;
  onSplit: (orientation: SplitOrientation) => void;
  onNavigate: (direction: "left" | "right" | "up" | "down") => void;
  onClose: (paneId: string) => void;
}

interface ShortcutOptions {
  enabled: boolean;
}

function useTerminalSplitShortcuts(
  onSplit: (orientation: SplitOrientation) => void,
  options: ShortcutOptions,
): void {
  useScopedGlobalShortcutById(
    "terminal-split-h",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSplit("horizontal");
    },
    "terminal",
    options,
  );
  useScopedGlobalShortcutById(
    "terminal-split-v",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSplit("vertical");
    },
    "terminal",
    options,
  );
}

function useTerminalNavigationShortcuts(
  onNavigate: (direction: "left" | "right" | "up" | "down") => void,
  options: ShortcutOptions,
): void {
  useTerminalNavigationShortcut("terminal-nav-pane-left", "left", onNavigate, options);
  useTerminalNavigationShortcut("terminal-nav-pane-right", "right", onNavigate, options);
  useTerminalNavigationShortcut("terminal-nav-pane-up", "up", onNavigate, options);
  useTerminalNavigationShortcut("terminal-nav-pane-down", "down", onNavigate, options);
}

function useTerminalNavigationShortcut(
  shortcutId:
    | "terminal-nav-pane-left"
    | "terminal-nav-pane-right"
    | "terminal-nav-pane-up"
    | "terminal-nav-pane-down",
  direction: "left" | "right" | "up" | "down",
  onNavigate: (direction: "left" | "right" | "up" | "down") => void,
  options: ShortcutOptions,
): void {
  useScopedGlobalShortcutById(
    shortcutId,
    (event) => {
      event.preventDefault();
      onNavigate(direction);
    },
    "terminal",
    options,
  );
}

function useTerminalActionShortcuts({
  resolvedActivePaneId,
  paneRefs,
  onClose,
  options,
}: Pick<UseTerminalPaneShortcutsParams, "resolvedActivePaneId" | "paneRefs" | "onClose"> & {
  options: ShortcutOptions;
}): void {
  useScopedGlobalShortcutById(
    "terminal-clear",
    (event) => {
      if (!resolvedActivePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      paneRefs.current.get(resolvedActivePaneId)?.clearScreen();
    },
    "terminal",
    options,
  );
  useScopedGlobalShortcutById(
    "terminal-delete-line",
    (event) => {
      if (!resolvedActivePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      paneRefs.current.get(resolvedActivePaneId)?.clearInput();
    },
    "terminal",
    options,
  );
  useScopedGlobalShortcutById(
    "terminal-close",
    (event) => {
      if (!resolvedActivePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(resolvedActivePaneId);
    },
    "terminal",
    options,
  );
}

/**
 * Registers all terminal-pane keyboard shortcuts (split, navigate, clear,
 * delete-line, close), scoped to the terminal tab so they don't fire from
 * another tab.
 *
 * We use the *global* capture-phase variant rather than `useHotkeys` so the
 * shortcuts still fire while xterm's textarea has focus — bubble-phase hotkeys
 * can be swallowed by xterm before they reach app handlers.
 */
export function useTerminalPaneShortcuts({
  hotkeysEnabled,
  resolvedActivePaneId,
  paneRefs,
  onSplit,
  onNavigate,
  onClose,
}: UseTerminalPaneShortcutsParams): void {
  const options = { enabled: hotkeysEnabled };
  useTerminalSplitShortcuts(onSplit, options);
  useTerminalNavigationShortcuts(onNavigate, options);
  useTerminalActionShortcuts({ resolvedActivePaneId, paneRefs, onClose, options });
}

interface UseTerminalCopyPasteShortcutsParams {
  hotkeysEnabled: boolean;
  resolvedActivePaneId: string | null;
  onCopy: (paneId: string) => void;
  onPaste: (paneId: string) => void;
}

/**
 * Copy/paste live outside `useTerminalPaneShortcuts` because the callbacks
 * (`copyPaneSelection`/`pasteIntoPane`) are only defined once the terminal
 * store's clipboard actions exist, in a later hook than the split/navigate/
 * close set — see `useTerminalPanelController`'s `runtime` vs `layout` split.
 *
 * The terminal draws to a WebGPU canvas, not a DOM text node, so there is no
 * browser selection for the OS's native Cmd+C/Cmd+V to act on — these are
 * what actually move bytes for a terminal pane.
 */
export function useTerminalCopyPasteShortcuts({
  hotkeysEnabled,
  resolvedActivePaneId,
  onCopy,
  onPaste,
}: UseTerminalCopyPasteShortcutsParams): void {
  const options = { enabled: hotkeysEnabled };
  useScopedGlobalShortcutById(
    "terminal-copy",
    (event) => {
      if (!resolvedActivePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      onCopy(resolvedActivePaneId);
    },
    "terminal",
    options,
  );
  useScopedGlobalShortcutById(
    "terminal-paste",
    (event) => {
      if (!resolvedActivePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      onPaste(resolvedActivePaneId);
    },
    "terminal",
    options,
  );
}
