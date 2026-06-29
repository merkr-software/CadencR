import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useWsSessionStore } from "@/stores/ws-session-store";

interface BranchConfirmDialogProps {
  /** Only render when the pending confirm targets this session. */
  wsSessionId: string;
}

/**
 * Dirty-worktree confirmation for a rewind. The backend replies
 * `branch.needs_confirm` when restoring would discard uncommitted changes;
 * confirming re-runs the rewind with `confirmDiscard`. Mounted per-session and
 * gated on the pending confirm's session id, so exactly one dialog can show.
 */
export function BranchConfirmDialog({ wsSessionId }: BranchConfirmDialogProps) {
  const branchConfirm = useWsSessionStore((s) =>
    s.branchConfirm?.sessionId === wsSessionId ? s.branchConfirm : null,
  );
  const resolveBranchConfirm = useWsSessionStore((s) => s.resolveBranchConfirm);

  return (
    <ConfirmDialog
      open={branchConfirm != null}
      onOpenChange={(next) => !next && resolveBranchConfirm(false)}
      title="Discard changes and rewind?"
      description={`${
        branchConfirm?.reason ?? "Rewinding will discard uncommitted changes in the worktree."
      } This cannot be undone.`}
      confirmText="Discard & rewind"
      variant="destructive"
      onConfirm={() => resolveBranchConfirm(true)}
    />
  );
}
