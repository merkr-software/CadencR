import { SessionConfigPopover, shouldShowSessionConfig } from "./SessionConfigPopover";
import type { SessionConfigControls } from "./types";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { SlidingText } from "@/components/SlidingText";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { AutoScrollChip } from "./AutoScrollChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeChip } from "./WorktreeChip";
import type { ClaudeCodeProfile, RuntimeProviderAccessModeOption } from "@/api/agentRuntime";
import { findProviderMode, getVisibleModes } from "@/lib/provider-modes";
import type { AccessMode } from "@/types/access-mode";
import type { MetaBarProps } from "./MetaBar";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { AccessModePopover } from "./AccessModePopover";
import { getDisplayMode } from "./meta-bar-codex-modes";
import { ClaudeProfileCombobox } from "./ClaudeProfileCombobox";

type MetaBarDerivedStateInput = Pick<
  MetaBarProps,
  | "sessionConfigControls"
  | "providers"
  | "models"
  | "onPermissionModeToggle"
  | "permissionMode"
  | "enabledOptInModes"
  | "providerModes"
  | "variant"
  | "onModelChange"
  | "showReadOnlyModel"
  | "accessMode"
  | "onAccessModeChange"
  | "providerAccessModes"
  | "showClaudeProfileSelector"
  | "claudeProfile"
  | "onClaudeProfileChange"
  | "secondaryBelow"
  | "runtimeSessionId"
  | "onPause"
>;

export function useMetaBarDerivedState(
  props: MetaBarDerivedStateInput,
  displayProviderId: string | undefined,
) {
  const {
    providers = [],
    models,
    onPermissionModeToggle,
    permissionMode,
    enabledOptInModes,
    providerModes = [],
    variant = "session",
    onModelChange,
    showReadOnlyModel = false,
    accessMode,
    onAccessModeChange,
    providerAccessModes = [],
    showClaudeProfileSelector = false,
    claudeProfile,
    onClaudeProfileChange,
    secondaryBelow = false,
    runtimeSessionId,
    onPause,
  } = props;

  const pickerProviders = useMemo(() => {
    if (providers.length > 0) {
      return providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        disabled: provider.disabled,
        models: provider.models,
      }));
    }
    if (!displayProviderId) return [];
    return [{ id: displayProviderId, label: displayProviderId, disabled: false, models }];
  }, [displayProviderId, models, providers]);

  // Hide the chip when the provider can't cycle (< 2 visible modes).
  const activeMode = useMemo(() => {
    if (!onPermissionModeToggle || !permissionMode) return null;
    const visibleModes = getVisibleModes(displayProviderId, enabledOptInModes ?? [], providerModes);
    if (visibleModes.length < 2) return null;
    return findProviderMode(displayProviderId, permissionMode, providerModes) ?? visibleModes[0];
  }, [displayProviderId, enabledOptInModes, onPermissionModeToggle, permissionMode, providerModes]);

  const displayMode = getDisplayMode(activeMode, displayProviderId, permissionMode);
  const isStandalone = variant === "standalone";
  const shouldShowModel = !!onModelChange || showReadOnlyModel;
  const hasAccessMode = !!accessMode && !!onAccessModeChange && providerAccessModes.length > 0;
  const hasProfileSelector =
    showClaudeProfileSelector && !!claudeProfile && !!onClaudeProfileChange;
  const hasTrailingGroup =
    hasProfileSelector ||
    hasAccessMode ||
    !!(!secondaryBelow && runtimeSessionId && onPause) ||
    !!props.sessionConfigControls;

  return {
    pickerProviders,
    displayMode,
    isStandalone,
    shouldShowModel,
    hasAccessMode,
    hasProfileSelector,
    hasTrailingGroup,
  };
}

interface TrailingGroupProps {
  sessionConfigControls?: SessionConfigControls;
  hasProfileSelector: boolean;
  hasAccessMode: boolean;
  secondaryBelow: boolean;
  claudeProfile?: string;
  claudeProfiles: ClaudeCodeProfile[];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  onClaudeProfileChange?: (profile: string) => void;
  accessMode?: AccessMode;
  accessModeDefault?: AccessMode;
  isAccessModePending: boolean;
  onAccessModeChange?: (mode: AccessMode) => void;
  displayProviderId?: string;
  providerAccessModes: readonly RuntimeProviderAccessModeOption[];
  runtimeSessionId?: string;
  featureId?: number;
  wsSessionId?: string;
  projectPath?: string;
  isRunning: boolean;
  onPause?: () => void;
}

export function MetaBarTrailingGroup(props: TrailingGroupProps) {
  const config = props.sessionConfigControls;
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {props.hasProfileSelector && props.claudeProfile && props.onClaudeProfileChange && (
        <ClaudeProfileCombobox
          value={props.claudeProfile}
          profiles={props.claudeProfiles}
          isLoading={props.claudeProfilesLoading}
          isError={props.claudeProfilesError}
          onChange={props.onClaudeProfileChange}
          variant="compact"
          label="Profile"
        />
      )}

      {/* Provider access chip — separate from collaboration mode; no keyboard shortcut. */}
      {props.accessMode && props.onAccessModeChange && props.providerAccessModes.length > 0 && (
        <AccessModePopover
          mode={props.accessMode}
          selectedMode={props.accessModeDefault}
          isPending={props.isAccessModePending}
          onChange={props.onAccessModeChange}
          providerId={props.displayProviderId}
          options={props.providerAccessModes}
        />
      )}

      {config &&
        shouldShowSessionConfig(config.config, config.loading, config.supported, config.error) && (
          <SessionConfigPopover {...config} />
        )}

      {/* Session info */}
      {!props.secondaryBelow && props.runtimeSessionId && props.onPause && (
        <SessionInfoChip
          runtimeProvider={props.displayProviderId}
          runtimeSessionId={props.runtimeSessionId}
          featureId={props.featureId}
          wsSessionId={props.wsSessionId}
          projectPath={props.projectPath}
          isRunning={props.isRunning}
          onPause={props.onPause}
          chipClass={META_BAR_CHIP}
          claudeProfile={props.claudeProfile}
          claudeProfiles={props.claudeProfiles}
          claudeProfilesLoading={props.claudeProfilesLoading}
          claudeProfilesError={props.claudeProfilesError}
          onClaudeProfileChange={props.onClaudeProfileChange}
        />
      )}
    </div>
  );
}

interface LeadingChipsProps {
  showAutoScrollChip: boolean;
  secondaryBelow: boolean;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  displayMode: ReturnType<typeof getDisplayMode>;
  onPermissionModeToggle?: () => void;
  showWorktreeChip: boolean;
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
  worktreeProjectPath?: string;
  worktreeMode?: import("@/lib/worktree-mode").WorktreeMode;
  onWorktreeModeChange?: (mode: import("@/lib/worktree-mode").WorktreeMode) => void;
  worktreeSelectedBranch?: string | null;
  onWorktreeBranchChange?: (next: string | null) => void;
}

export function MetaBarLeadingChips(props: LeadingChipsProps) {
  return (
    <>
      {props.showAutoScrollChip && !props.secondaryBelow && (
        <AutoScrollChip enabled={props.autoScrollEnabled} onToggle={props.onToggleAutoScroll} />
      )}

      {/* Mode chip — labels/colors driven by the per-provider catalog. */}
      {props.displayMode && (
        <ShortcutTooltip label={`${props.displayMode.label} mode`} keys={["shift", "Tab"]}>
          <button
            type="button"
            onClick={props.onPermissionModeToggle}
            title={`${props.displayMode.description} (Shift+Tab to cycle)`}
            aria-label={props.displayMode.ariaLabel}
            className={cn(META_BAR_CHIP, props.displayMode.chipClass, "min-w-0")}
          >
            <props.displayMode.icon className="size-3 shrink-0" />
            <SlidingText text={props.displayMode.label} className="max-w-[160px]" />
          </button>
        </ShortcutTooltip>
      )}

      {/* Worktree chip — inline when wide; on narrow widths it drops to the
          `MetaBarSecondary` strip below the prompt (`secondaryBelow`). */}
      {props.showWorktreeChip && !props.secondaryBelow && (
        <WorktreeChip
          worktreeProjectId={props.worktreeProjectId}
          worktreeDefaultBranch={props.worktreeDefaultBranch}
          worktreeProjectPath={props.worktreeProjectPath}
          worktreeMode={props.worktreeMode}
          onWorktreeModeChange={props.onWorktreeModeChange}
          worktreeSelectedBranch={props.worktreeSelectedBranch}
          onWorktreeBranchChange={props.onWorktreeBranchChange}
        />
      )}
    </>
  );
}
