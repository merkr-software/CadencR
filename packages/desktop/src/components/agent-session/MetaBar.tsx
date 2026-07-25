import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { AgentTodoList } from "../AgentTodoList";
import { AutoScrollChip } from "./AutoScrollChip";
import { PermissionModeChip } from "./PermissionModeChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeChip } from "./WorktreeChip";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { TodoItem } from "@/types/agent";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";
import type { AccessMode } from "@/types/access-mode";
import type {
  RuntimeProviderAccessModeOption,
  RuntimeProviderModeOption,
} from "@/api/agentRuntime";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import { ModelMetaChip, type Model, type Provider } from "./ModelMetaChip";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { AccessModePopover } from "./AccessModePopover";
import { ClaudeProfileCombobox } from "./ClaudeProfileCombobox";
import type { ModelSelectionStatus } from "./useAgentSessionModelState";

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
  providerAccessModes?: readonly RuntimeProviderAccessModeOption[];
  accessMode?: AccessMode;
  accessModeDefault?: AccessMode;
  isAccessModePending?: boolean;
  onAccessModeChange?: (mode: AccessMode) => void;
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
  activeClaudeProfile?: string;
  onClaudeProfileChange?: (profile: string) => void;
  showReadOnlyModel?: boolean;
  currentModelId?: string;
  currentModelLabel: string;
  modelSelectionStatus?: ModelSelectionStatus;
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

function useMetaBarState(props: MetaBarProps, ref: React.ForwardedRef<MetaBarHandle>) {
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const displayProviderId = props.currentProviderId || props.runtimeProvider;
  const isSelectionPending = (props.modelSelectionStatus ?? "ready") !== "ready";
  useImperativeHandle(ref, () => ({ openModelPicker: () => setModelPickerOpen(true) }), []);
  const pickerProviders = useMemo(() => {
    if (props.providers && props.providers.length > 0) {
      return props.providers.map((provider) => ({
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
        models: props.models,
      },
    ];
  }, [displayProviderId, props.models, props.providers]);
  return useMemo(
    () => ({
      displayProviderId,
      isSelectionPending,
      modelPickerOpen,
      pickerProviders,
      setModelPickerOpen,
    }),
    [displayProviderId, isSelectionPending, modelPickerOpen, pickerProviders],
  );
}

type MetaBarState = ReturnType<typeof useMetaBarState>;

export const MetaBar = forwardRef<MetaBarHandle, MetaBarProps>(function MetaBar(props, ref) {
  const state = useMetaBarState(props, ref);
  const isStandalone = props.variant === "standalone";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        isStandalone ? "px-3 py-2" : "relative -mt-6 px-3 py-3 backdrop-blur-sm",
      )}
      style={isStandalone ? undefined : { background: META_BAR_GRADIENT }}
    >
      <MetaBarPrimary props={props} state={state} />
      <MetaBarTrailing props={props} state={state} />
    </div>
  );
});

const META_BAR_GRADIENT =
  "linear-gradient(to bottom, transparent 0%, hsl(var(--background) / 0.05) 10%, hsl(var(--background) / 0.12) 20%, hsl(var(--background) / 0.25) 35%, hsl(var(--background) / 0.45) 50%, hsl(var(--background) / 0.65) 65%, hsl(var(--background) / 0.82) 80%, hsl(var(--background) / 0.93) 90%, hsl(var(--background)) 100%)";

function MetaBarPrimary({ props, state }: { props: MetaBarProps; state: MetaBarState }) {
  const showModel = !!props.onModelChange || props.showReadOnlyModel;
  return (
    <>
      {props.showAutoScrollChip && !props.secondaryBelow && (
        <AutoScrollChip enabled={props.autoScrollEnabled} onToggle={props.onToggleAutoScroll} />
      )}
      {/* Hidden mid-selection, as it was inline: the provider is about to change
          and with it which modes exist. */}
      {!state.isSelectionPending && (
        <PermissionModeChip
          providerId={state.displayProviderId}
          permissionMode={props.permissionMode}
          enabledOptInModes={props.enabledOptInModes}
          providerModes={props.providerModes}
          onToggle={props.onPermissionModeToggle}
        />
      )}
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
      {showModel && (
        <ModelMetaChip
          open={state.modelPickerOpen}
          onOpenChange={state.setModelPickerOpen}
          currentProviderId={state.displayProviderId}
          currentModelId={props.currentModelId}
          currentModelLabel={props.currentModelLabel}
          modelSelectionStatus={props.modelSelectionStatus}
          pickerProviders={state.pickerProviders}
          canChangeProvider={props.canChangeProvider ?? false}
          onProviderChange={props.onProviderChange}
          onModelChange={props.onModelChange}
          currentThinkingEffort={props.currentThinkingEffort}
          supportedThinkingEfforts={props.supportedThinkingEfforts ?? []}
          onThinkingEffortChange={props.onThinkingEffortChange}
          onModelSelected={props.onModelSelected}
        />
      )}
      {!props.secondaryBelow && props.todos && props.todos.length > 0 && (
        <AgentTodoList todos={props.todos} chipClass={META_BAR_CHIP} />
      )}
    </>
  );
}

function MetaBarTrailing({ props, state }: { props: MetaBarProps; state: MetaBarState }) {
  const hasProfile =
    !state.isSelectionPending &&
    props.showClaudeProfileSelector &&
    !!props.claudeProfile &&
    !!props.onClaudeProfileChange;
  const hasAccess =
    !state.isSelectionPending &&
    !!props.accessMode &&
    !!props.onAccessModeChange &&
    (props.providerAccessModes?.length ?? 0) > 0;
  const hasSession = !props.secondaryBelow && !!props.runtimeSessionId && !!props.onPause;
  if (!hasProfile && !hasAccess && !hasSession) return null;
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {hasProfile && props.claudeProfile && props.onClaudeProfileChange && (
        <ClaudeProfileCombobox
          value={props.claudeProfile}
          profiles={props.claudeProfiles ?? []}
          isLoading={props.claudeProfilesLoading ?? false}
          isError={props.claudeProfilesError ?? false}
          activeProfile={props.activeClaudeProfile}
          onChange={props.onClaudeProfileChange}
          variant="compact"
          label="Profile"
        />
      )}
      {hasAccess &&
        props.accessMode &&
        props.onAccessModeChange &&
        (props.providerAccessModes?.length ?? 0) > 0 && (
          <AccessModePopover
            mode={props.accessMode}
            selectedMode={props.accessModeDefault}
            isPending={props.isAccessModePending ?? false}
            onChange={props.onAccessModeChange}
            providerId={state.displayProviderId}
            options={props.providerAccessModes ?? []}
          />
        )}
      {hasSession && props.runtimeSessionId && props.onPause && (
        <SessionInfoChip
          runtimeProvider={props.runtimeProvider}
          runtimeSessionId={props.runtimeSessionId}
          featureId={props.featureId}
          wsSessionId={props.wsSessionId}
          projectPath={props.projectPath}
          isRunning={props.isRunning ?? false}
          onPause={props.onPause}
          chipClass={META_BAR_CHIP}
          claudeProfile={props.claudeProfile}
          claudeProfiles={props.claudeProfiles ?? []}
          claudeProfilesLoading={props.claudeProfilesLoading ?? false}
          claudeProfilesError={props.claudeProfilesError ?? false}
          activeClaudeProfile={props.activeClaudeProfile}
          onClaudeProfileChange={props.onClaudeProfileChange}
        />
      )}
    </div>
  );
}
