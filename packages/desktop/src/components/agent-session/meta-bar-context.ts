import { useImperativeHandle } from "react";
import { cn } from "@/lib/utils";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { TodoItem } from "@/types/agent";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { AccessMode } from "@/types/access-mode";
import type { RuntimeProviderAccessModeOption } from "@/api/agentRuntime";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import type { RuntimeSelection } from "@/shared/models";
import type { MetaBarHandle, MetaBarProps } from "./MetaBar";

export interface MetaBarInput {
  showAutoScrollChip: boolean;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  providerAccessModes: readonly RuntimeProviderAccessModeOption[];
  accessModeDefault: AccessMode | undefined;
  isAccessModePending: boolean;
  onAccessModeChange: ((mode: AccessMode) => void) | undefined;
  showWorktreeChip: boolean;
  worktreeMode: WorktreeMode | undefined;
  onWorktreeModeChange: ((mode: WorktreeMode) => void) | undefined;
  worktreeProjectId: number | undefined;
  worktreeDefaultBranch: string | undefined;
  worktreeProjectPath: string | undefined;
  worktreeSelectedBranch: string | null | undefined;
  onWorktreeBranchChange: ((next: string | null) => void) | undefined;
  onProviderChange: ((providerId: string) => void) | undefined;
  onModelChange: ((providerId: string, modelId: string) => void) | undefined;
  currentThinkingEffort: ThinkingEffortLevel | undefined;
  supportedThinkingEfforts: ThinkingEffortLevel[];
  onThinkingEffortChange: ((thinkingEffort?: ThinkingEffortLevel) => void) | undefined;
  claudeProfile: string | undefined;
  claudeProfiles: ClaudeCodeProfile[];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  onClaudeProfileChange: ((profile: string) => void) | undefined;
  currentSelection: RuntimeSelection | null;
  canChangeProvider: boolean;
  todos: TodoItem[] | null | undefined;
  runtimeSessionId: string | undefined;
  featureId: number | undefined;
  wsSessionId: string | undefined;
  projectPath: string | undefined;
  isRunning: boolean;
  onPause: (() => void) | undefined;
  onModelSelected: (() => void) | undefined;
  secondaryBelow: boolean;
}

export function useMetaBarInput(props: MetaBarProps): MetaBarInput {
  return {
    showAutoScrollChip: props.showAutoScrollChip,
    autoScrollEnabled: props.autoScrollEnabled,
    onToggleAutoScroll: props.onToggleAutoScroll,
    providerAccessModes: props.providerAccessModes ?? [],
    accessModeDefault: props.accessModeDefault,
    isAccessModePending: props.isAccessModePending ?? false,
    onAccessModeChange: props.onAccessModeChange,
    showWorktreeChip: props.showWorktreeChip,
    worktreeMode: props.worktreeMode,
    onWorktreeModeChange: props.onWorktreeModeChange,
    worktreeProjectId: props.worktreeProjectId,
    worktreeDefaultBranch: props.worktreeDefaultBranch,
    worktreeProjectPath: props.worktreeProjectPath,
    worktreeSelectedBranch: props.worktreeSelectedBranch,
    onWorktreeBranchChange: props.onWorktreeBranchChange,
    onProviderChange: props.onProviderChange,
    onModelChange: props.onModelChange,
    currentThinkingEffort: props.currentThinkingEffort,
    supportedThinkingEfforts: props.supportedThinkingEfforts ?? [],
    onThinkingEffortChange: props.onThinkingEffortChange,
    claudeProfile: props.claudeProfile,
    claudeProfiles: props.claudeProfiles ?? [],
    claudeProfilesLoading: props.claudeProfilesLoading ?? false,
    claudeProfilesError: props.claudeProfilesError ?? false,
    onClaudeProfileChange: props.onClaudeProfileChange,
    currentSelection: props.currentSelection,
    canChangeProvider: props.canChangeProvider ?? false,
    todos: props.todos,
    runtimeSessionId: props.runtimeSessionId,
    featureId: props.featureId,
    wsSessionId: props.wsSessionId,
    projectPath: props.projectPath,
    isRunning: props.isRunning ?? false,
    onPause: props.onPause,
    onModelSelected: props.onModelSelected,
    secondaryBelow: props.secondaryBelow ?? false,
  };
}

export function useMetaBarForwardRef(
  ref: React.Ref<MetaBarHandle>,
  setInternalModelPickerOpen: (open: boolean) => void,
) {
  useImperativeHandle(
    ref,
    () => ({
      openModelPicker: () => setInternalModelPickerOpen(true),
    }),
    [],
  );
}

/**
 * `@container`: Fast mode drops its text label by this bar's width, not the
 * window — the agent pane is often a narrow side column.
 *
 * No fade and no overhang of its own: the transcript dissolves at its own
 * bottom edge (`STREAM_DISSOLVE_STYLE`), so this row always sits on plain page.
 */
export function useMetaBarContainerClassName(variant: "session" | "standalone"): string {
  return cn(
    "@container flex items-center gap-1.5 px-3",
    variant === "standalone" ? "py-2" : "py-3",
  );
}
