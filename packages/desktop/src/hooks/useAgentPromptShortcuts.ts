/**
 * Keyboard shortcuts for `AgentPromptBar`, extracted to keep that file within
 * its line-count budget. Behaviour is unchanged: each binding no-ops when its
 * handler is absent, and the bindings are scoped to the `agent` group (except
 * stop, which is global but gated on focus being inside the bar, and needs a
 * second Esc inside `STOP_ARM_WINDOW_MS` — see `stop-arm-store`).
 */
import { type RefObject } from "react";
import { useScopedShortcut, useShortcut } from "@/hooks/useShortcut";
import { focusInSkillWizard } from "@/components/composer/skill-wizard-focus";
import { useStopArmStore } from "@/stores/stop-arm-store";

/** An open typeahead/popover inside the composer owns Esc (it closes first). */
const COMPOSER_POPOVER_SELECTOR = "[data-composer-popover]";

interface UseAgentPromptShortcutsParams {
  agentTabActive: boolean;
  isRunning: boolean;
  wrapperRef: RefObject<HTMLDivElement | null>;
  /** Identifies this composer for the two-press stop gesture. */
  stopArmKey: string;
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
  stopArmKey,
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
      if (!onOpenModelPicker || focusInSkillWizard(wrapperRef.current ?? document)) return;
      e.preventDefault();
      onOpenModelPicker();
    },
    "agent",
    { enabled: agentTabActive && onOpenModelPicker !== undefined },
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
      if (!onPermissionModeToggle || focusInSkillWizard(wrapperRef.current ?? document)) return;
      e.preventDefault();
      onPermissionModeToggle();
    },
    "agent",
    { enabled: agentTabActive && onPermissionModeToggle !== undefined },
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
      // In the skill wizard, Esc returns to the prompt instead.
      if (!isRunning || e.defaultPrevented || focusInSkillWizard(wrapperRef.current ?? document))
        return;
      const wrapper = wrapperRef.current;
      if (!wrapper?.contains(document.activeElement)) return;
      if (wrapper.querySelector(COMPOSER_POPOVER_SELECTOR)) return;
      e.preventDefault();
      const { armedKey, arm, disarm } = useStopArmStore.getState();
      if (armedKey === stopArmKey) {
        disarm();
        onStop();
      } else {
        arm(stopArmKey);
      }
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [isRunning, onStop, stopArmKey],
  );
}
