import { memo } from "react";
import { AgentTodoList } from "../AgentTodoList";
import { AutoScrollChip } from "./AutoScrollChip";
import { SessionInfoChip } from "./SessionInfoChip";
import { WorktreeChip, type WorktreeChipProps } from "./WorktreeChip";
import type { TodoItem } from "@/types/agent";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";

/**
 * Compact strip rendered *below* the prompt when the agent session container
 * is too narrow to fit every chip on a single row of the main `MetaBar`.
 *
 * Hosts the chips that don't need to live next to the model picker:
 *   - auto-scroll toggle (bottom-left lead chip)
 *   - branch + worktree selection
 *   - todos popover
 *   - session info popover (pushed to the right with `ml-auto`)
 *
 * Keep this component visually identical to the inline version inside
 * `MetaBar` — the only difference is its position in the DOM.
 */

export interface MetaBarSecondaryProps extends WorktreeChipProps {
  showWorktreeChip: boolean;
  showAutoScrollChip: boolean;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  todos?: TodoItem[] | null;
  runtimeProvider?: string;
  runtimeSessionId?: string;
  featureId?: number;
  wsSessionId?: string;
  projectPath?: string;
  isRunning?: boolean;
  onPause?: () => void;
  claudeProfile?: string;
  claudeProfiles?: ClaudeCodeProfile[];
  claudeProfilesLoading?: boolean;
  claudeProfilesError?: boolean;
  onClaudeProfileChange?: (profile: string) => void;
}

export const MetaBarSecondary = memo(function MetaBarSecondary({
  showWorktreeChip,
  showAutoScrollChip,
  autoScrollEnabled,
  onToggleAutoScroll,
  todos,
  runtimeProvider,
  runtimeSessionId,
  featureId,
  wsSessionId,
  projectPath,
  isRunning = false,
  onPause,
  claudeProfile,
  claudeProfiles = [],
  claudeProfilesLoading = false,
  claudeProfilesError = false,
  onClaudeProfileChange,
  worktreeMode,
  onWorktreeModeChange,
  worktreeProjectId,
  worktreeDefaultBranch,
  worktreeProjectPath,
  worktreeSelectedBranch,
  onWorktreeBranchChange,
}: MetaBarSecondaryProps) {
  const hasTodos = todos && todos.length > 0;
  const hasInfo = runtimeSessionId && onPause;
  if (!showWorktreeChip && !showAutoScrollChip && !hasTodos && !hasInfo) return null;

  return (
    <div className="-mt-1 flex items-center gap-1.5 px-3 pb-2 pt-0">
      {showAutoScrollChip && (
        <AutoScrollChip enabled={autoScrollEnabled} onToggle={onToggleAutoScroll} />
      )}

      {showWorktreeChip && (
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

      {hasTodos && <AgentTodoList todos={todos} chipClass={META_BAR_CHIP} />}

      {hasInfo && (
        <div className="ml-auto">
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
        </div>
      )}
    </div>
  );
});
