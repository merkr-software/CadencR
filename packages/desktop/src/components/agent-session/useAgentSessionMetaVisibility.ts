import type { AgentSessionProps } from "./types";
import { useIsNewConversation } from "./AgentSessionHistoryFailure";

export function useAgentSessionMetaVisibility(
  props: AgentSessionProps,
  isClaudeProvider: boolean,
  shouldShowPromptBar: boolean,
) {
  const {
    blocks,
    onWorktreeModeChange,
    worktreeProjectId,
    onPermissionModeToggle,
    onAccessModeChange,
    onModelChange,
    showReadOnlyModel,
    runtimeSessionId,
    onStop,
    todos,
  } = props;
  const isNewConversation = useIsNewConversation(props.wsSessionId, blocks.length);
  const showWorktreeChip = isNewConversation && !!onWorktreeModeChange && worktreeProjectId != null;
  const showClaudeProfileSelector = isClaudeProvider;
  const showAutoScrollChip = !!shouldShowPromptBar;

  const hasInlineMeta =
    !!onPermissionModeToggle ||
    !!onAccessModeChange ||
    !!onModelChange ||
    !!props.sessionConfigControls ||
    showClaudeProfileSelector ||
    !!showReadOnlyModel;
  const hasUtilityMeta =
    showWorktreeChip ||
    showAutoScrollChip ||
    !!(todos && todos.length > 0) ||
    !!(runtimeSessionId && onStop);
  const hasMeta = hasInlineMeta || hasUtilityMeta;

  return {
    showWorktreeChip,
    showClaudeProfileSelector,
    showAutoScrollChip,
    hasMeta,
  };
}
