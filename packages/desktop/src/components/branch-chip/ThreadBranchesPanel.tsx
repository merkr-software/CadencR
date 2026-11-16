/**
 * The header branch chip's popover: every branch of the conversation, the
 * current one first — under the directory's checkout when that is not one of
 * them — each with its own target and pull request. Changing a
 * target or linking a branch swaps the list for a picker in place, with a way
 * back.
 *
 * Switching branches is deliberately not offered: a worktree-free
 * conversation shares the project's checkout, and moving it from here would
 * move every other conversation working in that directory.
 */
import { useCallback, useState, type ReactElement } from "react";
import { ArrowLeftIcon, LinkIcon, Users } from "lucide-react";

import type { GitStatusSnapshot, ThreadBranch } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { prForBranch, threadPrs } from "@/lib/thread-prs";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { LinkBranchPicker, TargetBranchPicker } from "./BranchPicker";
import { ThreadBranchRow } from "./ThreadBranchRow";
import { checkoutOf, threadBranchesOf } from "./thread-branches";
import { UnlinkedCheckoutRow } from "./UnlinkedCheckoutRow";

type PanelView = { kind: "list" } | { kind: "target"; branch: ThreadBranch } | { kind: "link" };

interface ThreadBranchesPanelProps {
  featureId: number;
  projectId: number;
  snapshot: GitStatusSnapshot;
}

export function ThreadBranchesPanel({
  featureId,
  projectId,
  snapshot,
}: ThreadBranchesPanelProps): ReactElement {
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const backToList = useCallback(() => setView({ kind: "list" }), []);
  const editTarget = useCallback((branch: ThreadBranch) => setView({ kind: "target", branch }), []);

  if (view.kind === "target") {
    return (
      <div className="flex flex-col">
        <PanelHeader onBack={backToList}>
          Target for <span className="font-mono">{view.branch.name}</span>
        </PanelHeader>
        <TargetBranchPicker
          featureId={featureId}
          projectId={projectId}
          branch={view.branch.name}
          currentTarget={view.branch.target_branch}
          onPicked={backToList}
        />
      </div>
    );
  }
  if (view.kind === "link") {
    return (
      <div className="flex flex-col">
        <PanelHeader onBack={backToList}>Link a branch</PanelHeader>
        <LinkBranchPicker featureId={featureId} projectId={projectId} onLinked={backToList} />
      </div>
    );
  }
  return (
    <BranchList
      featureId={featureId}
      snapshot={snapshot}
      onEditTarget={editTarget}
      onLink={() => setView({ kind: "link" })}
    />
  );
}

function BranchList({
  featureId,
  snapshot,
  onEditTarget,
  onLink,
}: {
  featureId: number;
  snapshot: GitStatusSnapshot;
  onEditTarget: (branch: ThreadBranch) => void;
  onLink: () => void;
}): ReactElement {
  const prs = threadPrs(usePrStatusStore(selectPrStatus(featureId)));
  const branches = threadBranchesOf(snapshot);
  const checkout = checkoutOf(snapshot, branches);
  const sharedWith = snapshot.shared_with ?? [];
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="text-xs font-medium">Conversation branches</p>
        <span className="text-[11px] tabular-nums text-muted-foreground">{branches.length}</span>
      </div>
      <ul className="max-h-[min(24rem,60vh)] divide-y divide-border/60 overflow-y-auto">
        {checkout && !checkout.branch && (
          <UnlinkedCheckoutRow featureId={featureId} name={checkout.name} />
        )}
        {branches.map((branch) => (
          <ThreadBranchRow
            key={branch.name}
            featureId={featureId}
            branch={branch}
            pr={prForBranch(prs, branch)}
            divergence={
              branch.is_current
                ? { ahead: snapshot.ahead_of_target, behind: snapshot.behind_target ?? 0 }
                : undefined
            }
            onEditTarget={onEditTarget}
          />
        ))}
      </ul>
      {sharedWith.length > 0 && (
        <div
          className="flex items-start gap-1.5 border-t px-3 py-2 text-[11px] text-[var(--chip-shared-worktree-fg)]"
          data-testid="shared-worktree-indicator"
        >
          <Users className="mt-0.5 size-3 shrink-0" aria-hidden />
          <p>
            Worktree shared with {sharedWith.map((s) => s.title).join(", ")}. Changes here affect
            their view too.
          </p>
        </div>
      )}
      <div className="border-t p-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={onLink}
        >
          <LinkIcon />
          Link a branch…
        </Button>
      </div>
    </div>
  );
}

function PanelHeader({
  onBack,
  children,
}: {
  onBack: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1 border-b px-1.5 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Back to branches"
        onClick={onBack}
      >
        <ArrowLeftIcon />
      </Button>
      <p className="min-w-0 truncate text-xs font-medium">{children}</p>
    </div>
  );
}
