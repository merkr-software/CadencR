/**
 * The collaboration-mode chip — "Auto-Accept Edits", "Plan", "Read only"…
 *
 * Shared by the session composer (where Shift+Tab cycles it) and the schedule
 * editor (where there is no such binding, hence `showShortcut`). Both need the
 * same rule: a provider with fewer than two visible modes has nothing to cycle,
 * so the chip renders nothing rather than a dead control.
 */
import { type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { SlidingText } from "@/components/SlidingText";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { findProviderMode, getVisibleModes } from "@/lib/provider-modes";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { PermissionMode } from "@/types/permission-mode";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { getDisplayMode } from "./meta-bar-codex-modes";

export interface PermissionModeChipProps {
  providerId?: string;
  permissionMode?: PermissionMode;
  /**
   * Per-provider opt-in modes the user has unlocked via provider settings.
   * E.g. enabling "Allow BypassPermissions" for Claude Code adds
   * `"bypassPermissions"` to this list when the active provider is Claude.
   * Modes flagged `optIn: true` in the catalog are filtered out unless they
   * appear here.
   */
  enabledOptInModes?: PermissionMode[];
  providerModes?: readonly RuntimeProviderModeOption[];
  /** Advances to the next visible mode. Omit to hide the chip entirely. */
  onToggle?: () => void;
  /** Whether Shift+Tab reaches this chip; only a live session binds it. */
  showShortcut?: boolean;
}

export function PermissionModeChip({
  providerId,
  permissionMode,
  enabledOptInModes,
  providerModes = [],
  onToggle,
  showShortcut = true,
}: PermissionModeChipProps): ReactElement | null {
  if (!onToggle || !permissionMode) return null;
  const visibleModes = getVisibleModes(providerId, enabledOptInModes ?? [], providerModes);
  if (visibleModes.length < 2) return null;
  const activeMode = findProviderMode(providerId, permissionMode, providerModes) ?? visibleModes[0];
  const displayMode = getDisplayMode(activeMode, providerId, permissionMode);
  if (!displayMode) return null;

  const chip = (
    <button
      type="button"
      onClick={onToggle}
      title={
        showShortcut ? `${displayMode.description} (Shift+Tab to cycle)` : displayMode.description
      }
      aria-label={displayMode.ariaLabel}
      className={cn(META_BAR_CHIP, displayMode.chipClass, "min-w-0")}
    >
      <displayMode.icon className="size-3 shrink-0" />
      <SlidingText text={displayMode.label} className="max-w-[160px]" />
    </button>
  );

  if (!showShortcut) return chip;
  return (
    <ShortcutTooltip label={`${displayMode.label} mode`} keys={["shift", "Tab"]}>
      {chip}
    </ShortcutTooltip>
  );
}
