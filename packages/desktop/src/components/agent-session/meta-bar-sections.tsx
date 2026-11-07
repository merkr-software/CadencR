import { SessionConfigPopover, shouldShowSessionConfig } from "./SessionConfigPopover";
import type { SessionConfigControls } from "./types";
import { useMemo } from "react";
import { useShortcutKeys, useShortcutLabel } from "@/hooks/useShortcutLabel";
import { cn } from "@/lib/utils";
import { SlidingText } from "@/components/SlidingText";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { AutoScrollChip } from "./AutoScrollChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeChip } from "./WorktreeChip";
import type { ClaudeCodeProfile, RuntimeProviderAccessModeOption } from "@/api/agentRuntime";
import { findProviderMode, getVisibleModes } from "@/lib/provider-modes";
import type { AccessMode } from "@/types/access-mode";
import type { MetaBarProps, MetaBarSection } from "./MetaBar";
import type { PermissionMode } from "@/types/permission-mode";
import { ModeControl } from "../composer/ModeControl";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { AccessModePopover } from "./AccessModePopover";
import { getDisplayMode } from "./meta-bar-codex-modes";

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
    !!(runtimeSessionId && onPause) ||
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
  section: MetaBarSection;
  sessionConfigControls?: SessionConfigControls;
  hasProfileSelector: boolean;
  hasAccessMode: boolean;
  claudeProfile?: string;
  claudeProfiles: ClaudeCodeProfile[];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  onClaudeProfileChange?: (profile: string) => void;
  activeClaudeProfile?: string;
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
  const showControls = props.section !== "utilities";
  const showInfo = props.section !== "instruments";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        props.section === "instruments" ? "min-w-0 gap-0.5" : "ml-auto",
      )}
    >
      {/* Provider access chip — separate from collaboration mode; no keyboard shortcut. */}
      {showControls &&
        props.accessMode &&
        props.onAccessModeChange &&
        props.providerAccessModes.length > 0 && (
          <AccessModePopover
            mode={props.accessMode}
            selectedMode={props.accessModeDefault}
            isPending={props.isAccessModePending}
            onChange={props.onAccessModeChange}
            providerId={props.displayProviderId}
            options={props.providerAccessModes}
            variant={props.section === "instruments" ? "instrument" : "chip"}
          />
        )}

      {showControls &&
        config &&
        shouldShowSessionConfig(config.config, config.loading, config.supported, config.error) && (
          <SessionConfigPopover
            {...config}
            variant={props.section === "instruments" ? "instrument" : "chip"}
          />
        )}

      {/* Session info */}
      {showInfo && (props.hasProfileSelector || (props.runtimeSessionId && props.onPause)) && (
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
          activeClaudeProfile={props.activeClaudeProfile}
          showProfileSelector={props.hasProfileSelector}
        />
      )}
    </div>
  );
}

interface LeadingChipsProps {
  section: MetaBarSection;
  providerId?: string;
  permissionMode?: PermissionMode;
  enabledOptInModes?: PermissionMode[];
  providerModes?: MetaBarProps["providerModes"];
  onPermissionModeSet?: (mode: PermissionMode) => void;
  modeIncompatibleReason?: string | null;
  showAutoScrollChip: boolean;
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
  const { section } = props;
  const cycleKeys = useShortcutKeys("agent-permission-mode");
  const cycleLabel = useShortcutLabel("agent-permission-mode");
  return (
    <>
      {section !== "instruments" && props.showAutoScrollChip && (
        <AutoScrollChip enabled={props.autoScrollEnabled} onToggle={props.onToggleAutoScroll} />
      )}

      {section === "instruments" && (
        <ModeControl
          providerId={props.providerId}
          permissionMode={props.permissionMode}
          enabledOptInModes={props.enabledOptInModes}
          providerModes={props.providerModes}
          onSelect={props.onPermissionModeSet}
          incompatibleReason={props.modeIncompatibleReason}
        />
      )}

      {/* Mode chip — labels/colors driven by the per-provider catalog. */}
      {section === "all" && props.displayMode && (
        <ShortcutTooltip label={`${props.displayMode.label} mode`} keys={cycleKeys}>
          <button
            type="button"
            onClick={props.onPermissionModeToggle}
            title={`${props.displayMode.description} (${cycleLabel} to cycle)`}
            aria-label={props.displayMode.ariaLabel}
            className={cn(META_BAR_CHIP, props.displayMode.chipClass, "min-w-0")}
          >
            <props.displayMode.icon className="size-3 shrink-0" />
            <SlidingText text={props.displayMode.label} className="max-w-[160px]" />
          </button>
        </ShortcutTooltip>
      )}

      {/* Worktree chip — the single-row bar only; the composer moves branch and
          worktree choice into its launch manifest. */}
      {section === "all" && props.showWorktreeChip && (
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
