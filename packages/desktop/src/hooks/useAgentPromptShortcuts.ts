/**
 * Keyboard shortcuts for `AgentPromptBar`, extracted to keep that file within
 * its line-count budget. Behaviour is unchanged: each binding no-ops when its
 * handler is absent, and the bindings are scoped to the `agent` group (except
 * stop, which is global but gated on focus being inside the bar).
 */
import { type RefObject } from "react";
import { useScopedShortcut, useShortcut } from "@/hooks/useShortcut";

interface UseAgentPromptShortcutsParams {
  agentTabActive: boolean;
  isRunning: boolean;
  wrapperRef: RefObject<HTMLDivElement | null>;
  onOpenModelPicker?: () => void;
  onToggleMaximize?: () => void;
  onPermissionModeToggle?: () => void;
  onCollapse?: () => void;
  onStop: () => void;
}

export function useAgentPromptShortcuts({
  agentTabActive,
  isRunning,
  wrapperRef,
  onOpenModelPicker,
  onToggleMaximize,
  onPermissionModeToggle,
  onCollapse,
  onStop,
}: UseAgentPromptShortcutsParams): void {
  const hotkeyOpts = { enabled: agentTabActive };
  useScopedShortcut(
    "agent-model-picker",
    (e) => {
      if (!onOpenModelPicker) return;
      e.preventDefault();
      onOpenModelPicker();
    },
    "agent",
    hotkeyOpts,
  );
  useScopedShortcut(
    "agent-maximize",
    (e) => {
      if (!onToggleMaximize) return;
      e.preventDefault();
      onToggleMaximize();
    },
    "agent",
    hotkeyOpts,
  );
  useScopedShortcut(
    "agent-permission-mode",
    (e) => {
      if (!onPermissionModeToggle) return;
      e.preventDefault();
      onPermissionModeToggle();
    },
    "agent",
    hotkeyOpts,
  );
  useScopedShortcut(
    "agent-collapse",
    (e) => {
      if (isRunning || !onCollapse) return;
      e.preventDefault();
      onCollapse();
    },
    "agent",
    hotkeyOpts,
  );
  useShortcut(
    "agent-stop",
    (e) => {
      if (!isRunning) return;
      if (!wrapperRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      onStop();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [isRunning, onStop],
  );
}
