import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SlidingText } from "@/components/SlidingText";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { AgentTodoList } from "../AgentTodoList";
import { AutoScrollChip } from "./AutoScrollChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeChip } from "./WorktreeChip";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { TodoItem } from "@/types/agent";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import { findProviderMode, getVisibleModes } from "@/lib/provider-modes";
import type { PermissionMode } from "@/types/permission-mode";
import type { CodexPermissionMode } from "@/types/codex-permission-mode";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import { ModelMetaChip, type Model, type Provider } from "./ModelMetaChip";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { CodexAccessModePopover } from "./CodexAccessModePopover";
import { getDisplayMode } from "./meta-bar-codex-modes";
import { ClaudeProfileCombobox } from "./ClaudeProfileCombobox";

export interface MetaBarProps {
  showAutoScrollChip: boolean;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeToggle?: () => void;
  /**
   * Per-provider opt-in modes the user has unlocked via provider settings.
   * E.g. enabling "Allow BypassPermissions" for Claude Code adds
   * `"bypassPermissions"` to this list when the active provider is Claude.
   * Modes flagged `optIn: true` in the catalog are filtered out unless they
   * appear here.
   */
  enabledOptInModes?: PermissionMode[];
  providerModes?: readonly RuntimeProviderModeOption[];
  codexPermissionMode?: CodexPermissionMode;
  codexPermissionDefaultMode?: CodexPermissionMode;
  isCodexPermissionModePending?: boolean;
  onCodexPermissionModeChange?: (mode: CodexPermissionMode) => void;
  showWorktreeChip: boolean;
  /**
   * Branch/worktree behavior picker (Branch chip + explicit mode menu). The
   * chip renders only when the embedder supplies the project id, mode, and
   * both setters.
   */
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
  worktreeProjectPath?: string;
  worktreeMode?: WorktreeMode;
  onWorktreeModeChange?: (mode: WorktreeMode) => void;
  worktreeSelectedBranch?: string | null;
  onWorktreeBranchChange?: (next: string | null) => void;
  onProviderChange?: (providerId: string) => void;
  currentProviderId?: string;
  /**
   * Called when the user picks a model from the inline picker. The picker
   * always knows both the provider and the model the user just chose, so we
   * pass both — the parent must not read provider state from the WS store
   * here (no-optimistic-updates rule means it would be stale right after a
   * sibling provider change).
   */
  onModelChange?: (providerId: string, modelId: string) => void;
  currentThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts?: ThinkingEffortLevel[];
  onThinkingEffortChange?: (thinkingEffort?: ThinkingEffortLevel) => void;
  showClaudeProfileSelector?: boolean;
  claudeProfile?: string;
  claudeProfiles?: ClaudeCodeProfile[];
  claudeProfilesLoading?: boolean;
  claudeProfilesError?: boolean;
  onClaudeProfileChange?: (profile: string) => void;
  showReadOnlyModel?: boolean;
  currentModelId?: string;
  currentModelLabel: string;
  isModelCatalogLoading?: boolean;
  models: Model[];
  providers?: Provider[];
  canChangeProvider?: boolean;
  todos?: TodoItem[] | null;
  runtimeProvider?: string;
  runtimeSessionId?: string;
  /** Feature (conversation) id — enables the Info chip's "Sync from CLI" button. */
  featureId?: number;
  /** WS store key — used to merge synced events into the live conversation. */
  wsSessionId?: string;
  projectPath?: string;
  isRunning?: boolean;
  onPause?: () => void;
  onModelSelected?: () => void;
  /**
   * Layout variant. `"session"` (default) fades into the agent stream above
   * via a negative margin + background gradient. `"standalone"` drops that
   * styling so the bar can sit on its own inside a bordered container.
   */
  variant?: "session" | "standalone";
  /**
   * When `true`, the auto-scroll, todos, session-info, and worktree chips are
   * omitted because the parent renders them in a separate `MetaBarSecondary`
   * strip below the prompt (used when the container is too narrow to fit them
   * inline with the model picker / mode chips).
   */
  secondaryBelow?: boolean;
}

export interface MetaBarHandle {
  openModelPicker: () => void;
}

export const MetaBar = forwardRef<MetaBarHandle, MetaBarProps>(function MetaBar(
  {
    showAutoScrollChip,
    autoScrollEnabled,
    onToggleAutoScroll,
    permissionMode,
    onPermissionModeToggle,
    enabledOptInModes,
    providerModes = [],
    codexPermissionMode,
    codexPermissionDefaultMode,
    isCodexPermissionModePending = false,
    onCodexPermissionModeChange,
    showWorktreeChip,
    worktreeMode,
    onWorktreeModeChange,
    worktreeProjectId,
    worktreeDefaultBranch,
    worktreeProjectPath,
    worktreeSelectedBranch,
    onWorktreeBranchChange,
    onProviderChange,
    currentProviderId,
    onModelChange,
    currentThinkingEffort,
    supportedThinkingEfforts = [],
    onThinkingEffortChange,
    showClaudeProfileSelector = false,
    claudeProfile,
    claudeProfiles = [],
    claudeProfilesLoading = false,
    claudeProfilesError = false,
    onClaudeProfileChange,
    showReadOnlyModel = false,
    currentModelId,
    currentModelLabel,
    isModelCatalogLoading = false,
    models,
    providers = [],
    canChangeProvider = false,
    todos,
    runtimeProvider,
    runtimeSessionId,
    featureId,
    wsSessionId,
    projectPath,
    isRunning = false,
    onPause,
    onModelSelected,
    variant = "session",
    secondaryBelow = false,
  },
  ref,
) {
  const [internalModelPickerOpen, setInternalModelPickerOpen] = useState(false);
  const displayProviderId = currentProviderId ?? runtimeProvider;

  useImperativeHandle(
    ref,
    () => ({
      openModelPicker: () => setInternalModelPickerOpen(true),
    }),
    [],
  );
  const pickerProviders = useMemo(() => {
    if (providers.length > 0) {
      return providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        disabled: !!provider.disabled,
        models: provider.models,
      }));
    }
    if (!displayProviderId) return [];
    return [
      {
        id: displayProviderId,
        label: displayProviderId,
        disabled: false,
        models,
      },
    ];
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
  const hasCodexAccessMode = !!codexPermissionMode && !!onCodexPermissionModeChange;
  const hasProfileSelector =
    showClaudeProfileSelector && !!claudeProfile && !!onClaudeProfileChange;
  const hasTrailingGroup =
    hasProfileSelector || hasCodexAccessMode || (!secondaryBelow && runtimeSessionId && onPause);

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        isStandalone ? "px-3 py-2" : "relative -mt-6 px-3 py-3 backdrop-blur-sm",
      )}
      style={
        isStandalone
          ? undefined
          : {
              background:
                "linear-gradient(to bottom, transparent 0%, hsl(var(--background) / 0.05) 10%, hsl(var(--background) / 0.12) 20%, hsl(var(--background) / 0.25) 35%, hsl(var(--background) / 0.45) 50%, hsl(var(--background) / 0.65) 65%, hsl(var(--background) / 0.82) 80%, hsl(var(--background) / 0.93) 90%, hsl(var(--background)) 100%)",
            }
      }
    >
      {showAutoScrollChip && !secondaryBelow && (
        <AutoScrollChip enabled={autoScrollEnabled} onToggle={onToggleAutoScroll} />
      )}

      {/* Mode chip — labels/colors driven by the per-provider catalog. */}
      {displayMode && (
        <ShortcutTooltip label={`${displayMode.label} mode`} keys={["shift", "Tab"]}>
          <button
            type="button"
            onClick={onPermissionModeToggle}
            title={`${displayMode.description} (Shift+Tab to cycle)`}
            aria-label={displayMode.ariaLabel}
            className={cn(META_BAR_CHIP, displayMode.chipClass, "min-w-0")}
          >
            <displayMode.icon className="size-3 shrink-0" />
            <SlidingText text={displayMode.label} className="max-w-[160px]" />
          </button>
        </ShortcutTooltip>
      )}

      {/* Worktree chip — inline when wide; on narrow widths it drops to the
          `MetaBarSecondary` strip below the prompt (`secondaryBelow`). */}
      {showWorktreeChip && !secondaryBelow && (
        <WorktreeChip
          worktreeProjectId={worktreeProjectId}
          worktreeDefaultBranch={worktreeDefaultBranch}
          worktreeProjectPath={worktreeProjectPath}
          worktreeMode={worktreeMode}
          onWorktreeModeChange={onWorktreeModeChange}
          worktreeSelectedBranch={worktreeSelectedBranch}
          onWorktreeBranchChange={onWorktreeBranchChange}
        />
      )}

      {/* Model chip */}
      {shouldShowModel && (
        <ModelMetaChip
          open={internalModelPickerOpen}
          onOpenChange={setInternalModelPickerOpen}
          currentProviderId={displayProviderId}
          currentModelId={currentModelId}
          currentModelLabel={currentModelLabel}
          isModelCatalogLoading={isModelCatalogLoading}
          pickerProviders={pickerProviders}
          canChangeProvider={canChangeProvider}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          currentThinkingEffort={currentThinkingEffort}
          supportedThinkingEfforts={supportedThinkingEfforts}
          onThinkingEffortChange={onThinkingEffortChange}
          onModelSelected={onModelSelected}
        />
      )}

      {/* Tasks chip */}
      {!secondaryBelow && todos && todos.length > 0 && (
        <AgentTodoList todos={todos} chipClass={META_BAR_CHIP} />
      )}

      {hasTrailingGroup && (
        <div className="ml-auto flex items-center gap-1.5">
          {hasProfileSelector && (
            <ClaudeProfileCombobox
              value={claudeProfile}
              profiles={claudeProfiles}
              isLoading={claudeProfilesLoading}
              isError={claudeProfilesError}
              onChange={onClaudeProfileChange}
              variant="compact"
              label="Profile"
            />
          )}

          {/* Codex access chip — separate from collaboration mode; no keyboard shortcut. */}
          {codexPermissionMode && onCodexPermissionModeChange && (
            <CodexAccessModePopover
              mode={codexPermissionMode}
              selectedMode={codexPermissionDefaultMode}
              isPending={isCodexPermissionModePending}
              onChange={onCodexPermissionModeChange}
            />
          )}

          {/* Session info */}
          {!secondaryBelow && runtimeSessionId && onPause && (
            <SessionInfoChip
              runtimeProvider={runtimeProvider}
              runtimeSessionId={runtimeSessionId}
              featureId={featureId}
              wsSessionId={wsSessionId}
              projectPath={projectPath}
              isRunning={isRunning}
              onPause={onPause}
              chipClass={META_BAR_CHIP}
              claudeProfile={claudeProfile}
              claudeProfiles={claudeProfiles}
              claudeProfilesLoading={claudeProfilesLoading}
              claudeProfilesError={claudeProfilesError}
              onClaudeProfileChange={onClaudeProfileChange}
            />
          )}
        </div>
      )}
    </div>
  );
});
