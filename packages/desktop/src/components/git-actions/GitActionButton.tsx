import { memo, type ReactElement } from "react";

import { PhoneFeatureMoreSheet } from "@/components/phone-header/PhoneFeatureMoreSheet";
import type { WorktreeSetupHeaderProps } from "@/components/WorktreeSetupHeader";

import { GitActionDialogs } from "./GitActionDialogs";
import { GitActionControls } from "./GitActionControls";
import { useGitActionController } from "./useGitActionController";

interface GitActionButtonProps {
  featureId: number;
  projectId: number;
  /**
   * The phone layout: the picker is the header's "…" sheet, which also holds
   * what the phone header has no room for (the props below).
   */
  phone?: boolean;
  /** Phone only: the worktree's summary, memoized by `useWorktreeSetup`. */
  worktree?: WorktreeSetupHeaderProps | null;
  /** Phone only: the conversation's label. */
  featureLabel?: string | null;
  /** Phone only: list the custom actions in the sheet. */
  showCustomActions?: boolean;
}

/**
 * The feature header's Git control and its dialogs, in both layouts: the
 * split button on desktop, the "…" sheet on a phone. One host at one place in
 * the header, so the controller (an open dialog, a backgrounded run, a push's
 * options) survives the layout flipping — an iPad rotating, a window crossing
 * the phone width. Memo'd on primitive or memoized props, so the header's
 * re-render on every stream delta stops here.
 */
export const GitActionButton = memo(function GitActionButton({
  featureId,
  projectId,
  phone = false,
  worktree = null,
  featureLabel = null,
  showCustomActions = false,
}: GitActionButtonProps): ReactElement | null {
  const git = useGitActionController(featureId);
  return (
    <>
      {phone ? (
        <PhoneFeatureMoreSheet
          featureId={featureId}
          projectId={projectId}
          git={git}
          worktree={worktree}
          featureLabel={featureLabel}
          showCustomActions={showCustomActions}
        />
      ) : (
        <GitActionControls
          featureId={featureId}
          projectId={projectId}
          state={git.state}
          activities={git.activities}
          statusRetry={git.statusRetry}
          popoverOpen={git.pickerOpen}
          onPopoverOpenChange={git.setPickerOpen}
          onAction={git.runAction}
        />
      )}
      <GitActionDialogs {...git.dialogs} />
    </>
  );
});
