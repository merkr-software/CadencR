import type { AgentSessionProps } from "./types";

export function useAgentSessionMetaVisibility(
  props: AgentSessionProps,
  isClaudeProvider: boolean,
  isNarrow: boolean,
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
  const showClaudeProfileSelector = isClaudeProvider && blocks.length === 0;
  const showAutoScrollChip = !!shouldShowPromptBar;

  const hasInlineMeta =
    !!onPermissionModeToggle ||
    !!onAccessModeChange ||
    !!onModelChange ||
    !!props.sessionConfigControls ||
    showClaudeProfileSelector ||
    !!showReadOnlyModel ||
    (showWorktreeChip && !isNarrow);
  const hasSecondaryMeta =
    showWorktreeChip ||
    showAutoScrollChip ||
    !!(todos && todos.length > 0) ||
    !!(runtimeSessionId && onStop);
  const hasMeta = hasInlineMeta || (hasSecondaryMeta && !isNarrow);

  return {
    showWorktreeChip,
    showClaudeProfileSelector,
    showAutoScrollChip,
    hasMeta,
    hasSecondaryMeta,
  };
}
