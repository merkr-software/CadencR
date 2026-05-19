import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CheckIcon, GitBranchIcon } from "lucide-react";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { AgentTodoList } from "../AgentTodoList";
import { AutoScrollChip } from "./AutoScrollChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeButtonGroup } from "./WorktreePopover";
import type { TodoItem } from "@/types/agent";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import { findProviderMode, getVisibleModes } from "@/lib/provider-modes";
import type { PermissionMode } from "@/types/permission-mode";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import { ModelMetaChip, type Model, type Provider } from "./ModelMetaChip";
import { META_BAR_CHIP, WORKTREE_ACTIVE_CHIP } from "./meta-bar-chip-styles";

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
  showWorktreeChip: boolean;
  useWorktree?: boolean;
  onToggleWorktree?: () => void;
  /**
   * Optional richer two-chip worktree picker (Branch + Use worktree). When
   * the embedder provides every field below, the chip group replaces the
   * legacy on/off button. Embedders that don't supply these fall back to
   * the bare toggle.
   */
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
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
   * When `true`, the auto-scroll, todos, and session-info chips are omitted
   * because the parent renders them in a separate `MetaBarSecondary` strip
   * below the prompt (used when the container is too narrow to fit them
   * inline with the model picker / mode / worktree chips).
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
    showWorktreeChip,
    useWorktree,
    onToggleWorktree,
    worktreeProjectId,
    worktreeDefaultBranch,
    worktreeSelectedBranch,
    onWorktreeBranchChange,
    onProviderChange,
    currentProviderId,
    onModelChange,
    currentThinkingEffort,
    supportedThinkingEfforts = [],
    onThinkingEffortChange,
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

  const isStandalone = variant === "standalone";
  const shouldShowModel = !!onModelChange || showReadOnlyModel;

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
      {activeMode && (
        <ShortcutTooltip label={`${activeMode.label} mode`} keys={["shift", "Tab"]}>
          <button
            type="button"
            onClick={onPermissionModeToggle}
            title={`${activeMode.description} (Shift+Tab to cycle)`}
            aria-label={`Permission mode: ${activeMode.label}. ${activeMode.description}`}
            className={cn(META_BAR_CHIP, activeMode.chipClass)}
          >
            <activeMode.icon className="size-3" />
            {activeMode.label}
          </button>
        </ShortcutTooltip>
      )}

      {/* Worktree chips — two-chip group (Branch + Use worktree) when the
          embedder provides projectId + branch state, else legacy single toggle. */}
      {showWorktreeChip &&
        (worktreeProjectId != null && onWorktreeBranchChange && onToggleWorktree ? (
          <WorktreeButtonGroup
            projectId={worktreeProjectId}
            defaultBranch={worktreeDefaultBranch}
            useWorktree={!!useWorktree}
            onToggleWorktree={onToggleWorktree}
            selectedBranch={worktreeSelectedBranch ?? null}
            onSelectedBranchChange={onWorktreeBranchChange}
          />
        ) : (
          <button
            type="button"
            onClick={onToggleWorktree}
            className={cn(
              META_BAR_CHIP,
              useWorktree
                ? WORKTREE_ACTIVE_CHIP
                : "bg-muted/50 text-muted-foreground hover:bg-muted/80",
            )}
          >
            <GitBranchIcon className="size-3" />
            Use worktree
            {useWorktree && <CheckIcon className="size-3" />}
          </button>
        ))}

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

      {/* Session info */}
      {!secondaryBelow && runtimeSessionId && onPause && (
        <div className="ml-auto">
          <SessionInfoChip
            runtimeProvider={runtimeProvider}
            runtimeSessionId={runtimeSessionId}
            projectPath={projectPath}
            isRunning={isRunning}
            onPause={onPause}
            chipClass={META_BAR_CHIP}
          />
        </div>
      )}
    </div>
  );
});
