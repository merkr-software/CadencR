import type { AgentSessionProps } from "./types";

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
  const showWorktreeChip =
    blocks.length === 0 && !!onWorktreeModeChange && worktreeProjectId != null;
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
