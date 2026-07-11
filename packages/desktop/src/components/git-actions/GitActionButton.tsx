/**
 * Smart split-button surfaced in `FeatureTopBar`. The primary slot shows the
 * next sensible Git action (commit → push → PR) derived from the live
 * `GitStatusSnapshot`; the caret slot opens a popover listing all three with
 * tooltips that explain why each action is unavailable.
 *
 * Performance:
 * - Subscribes via narrow selectors so streaming updates from other features
 *   don't trigger re-renders here.
 * - `React.memo` plus a `useMemo` derivation hook keep the renders bound to
 *   actual snapshot changes.
 * - `CommitDialog` is loaded lazily so its file-list query and Radix Dialog
 *   subtree only mount when the dialog opens.
 */
import { lazy, memo, Suspense, useCallback, useState, type ReactElement } from "react";
import { CircleAlert, ChevronDown, GitBranch, GitCommit, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { getCompareUrl } from "@/api/generated";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import { useIsMobile } from "@/hooks/useIsMobile";
import { BranchChip } from "@/components/branch-chip/BranchChip";
import { isInCodeMirrorEditor } from "@/lib/shortcuts/dom-targets";
import { desktopBridge } from "@/lib/desktop-bridge";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import {
  useGitAction,
  type CommitActivity,
  type GitAction,
  type GitActionState,
} from "./useGitAction";
import { GitActionPopover, ICONS } from "./GitActionPopover";
import { useCommitSubmission } from "./useCommitSubmission";

const GIT_ACTION_BUTTON_CLASS =
  "border-border/80 bg-muted/20 text-xs text-foreground hover:bg-muted/35 disabled:opacity-100 disabled:bg-muted/20 disabled:text-muted-foreground";

const CommitDialog = lazy(() => import("./CommitDialog"));
const PushDialog = lazy(() => import("./PushDialog"));
const MergeDialog = lazy(() => import("./MergeDialog"));

interface GitActionButtonProps {
  featureId: number;
  projectId: number;
}

async function openExternal(url: string): Promise<void> {
  try {
    await desktopBridge.openExternal(url);
  } catch (error) {
    toast.error("Couldn't open compare URL.", {
      description: apiErrorMessage(error, String(error)),
    });
  }
}

export const GitActionButton = memo(function GitActionButton({
  featureId,
  projectId,
}: GitActionButtonProps): ReactElement | null {
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const state = useGitAction(snapshot);
  const isMobile = useIsMobile();
  const [commitOpen, setCommitOpen] = useState(false);
  const commitSubmission = useCommitSubmission({
    featureId,
    open: commitOpen,
    onOpenChange: setCommitOpen,
  });
  const commitActivity: CommitActivity = commitSubmission.submitting
    ? "running"
    : commitSubmission.outcome === "error"
      ? "failed"
      : null;
  const [pushOpen, setPushOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const openCommit = useCallback(() => setCommitOpen(true), []);
  const openPopover = useCallback(() => setPopoverOpen(true), []);

  const openPush = useCallback(() => setPushOpen(true), []);

  const runOpenCompare = useCallback(async () => {
    // Prefer the URL the backend already computed and shipped in the snapshot.
    let url = snapshot?.compare_url ?? null;
    if (!url) {
      try {
        const res = await getCompareUrl({ feature_id: featureId });
        if (res.available) url = res.url;
      } catch (err) {
        toastError(err, "Failed to resolve compare URL.");
        return;
      }
    }
    if (!url) {
      toast.error("Compare URL not available for this remote.");
      return;
    }
    await openExternal(url);
  }, [snapshot?.compare_url, featureId]);

  const runAction = useCallback(
    (action: GitAction) => {
      setPopoverOpen(false);
      if (action === "commit" && commitActivity) {
        openCommit();
        return;
      }
      if (state.disabled[action] !== null) return;
      if (action === "commit") openCommit();
      else if (action === "push") openPush();
      else if (action === "merge") setMergeOpen(true);
      else void runOpenCompare();
    },
    [commitActivity, state.disabled, openCommit, openPush, runOpenCompare],
  );

  useGitActionShortcuts({
    state,
    commitActivity,
    openCommit,
    openPush,
    openCompare: runOpenCompare,
    openPopover,
  });

  return (
    <>
      <GitActionControls
        featureId={featureId}
        projectId={projectId}
        isMobile={isMobile}
        state={state}
        commitActivity={commitActivity}
        popoverOpen={popoverOpen}
        onPopoverOpenChange={setPopoverOpen}
        onOpenCommit={openCommit}
        onAction={runAction}
      />
      <Suspense fallback={null}>
        {commitOpen && (
          <CommitDialog featureId={featureId} open={commitOpen} submission={commitSubmission} />
        )}
        {pushOpen && (
          <PushDialog featureId={featureId} open={pushOpen} onOpenChange={setPushOpen} />
        )}
        {mergeOpen && (
          <MergeDialog featureId={featureId} open={mergeOpen} onOpenChange={setMergeOpen} />
        )}
      </Suspense>
    </>
  );
});

interface GitActionControlsProps {
  featureId: number;
  projectId: number;
  isMobile: boolean;
  state: GitActionState;
  commitActivity: CommitActivity;
  popoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
  onOpenCommit: () => void;
  onAction: (action: GitAction) => void;
}

function GitActionControls(props: GitActionControlsProps): ReactElement {
  if (props.isMobile) return <MobileGitActionControl {...props} />;
  return <DesktopGitActionControl {...props} />;
}

function MobileGitActionControl({
  featureId,
  projectId,
  state,
  commitActivity,
  popoverOpen,
  onPopoverOpenChange,
  onOpenCommit,
  onAction,
}: GitActionControlsProps): ReactElement {
  if (commitActivity) {
    return (
      <div className="inline-flex items-center">
        <CommitActivityButton
          activity={commitActivity}
          onClick={onOpenCommit}
          className="rounded-r-none border-r-0"
        />
        <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={`${GIT_ACTION_BUTTON_CLASS} rounded-l-none px-1.5`}
              aria-label="More git actions"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b border-border px-3 py-2">
              <BranchChip featureId={featureId} projectId={projectId} />
            </div>
            <GitActionPopover state={state} commitActivity={commitActivity} onPick={onAction} />
          </PopoverContent>
        </Popover>
      </div>
    );
  }
  return (
    <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={GIT_ACTION_BUTTON_CLASS}
          aria-label="Git actions"
        >
          <GitBranch className="size-3.5" />
          <span>Git</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2">
          <BranchChip featureId={featureId} projectId={projectId} />
        </div>
        <GitActionPopover state={state} onPick={onAction} />
      </PopoverContent>
    </Popover>
  );
}

function DesktopGitActionControl({
  state,
  commitActivity,
  popoverOpen,
  onPopoverOpenChange,
  onOpenCommit,
  onAction,
}: GitActionControlsProps): ReactElement {
  const primaryAction = commitActivity ? "commit" : state.primary;
  const PrimaryIcon = primaryAction ? ICONS[primaryAction] : GitCommit;
  const primaryDisabled = primaryAction === null;
  return (
    <div className="inline-flex items-center">
      {commitActivity ? (
        <CommitActivityButton
          activity={commitActivity}
          onClick={onOpenCommit}
          className="rounded-r-none border-r-0"
        />
      ) : (
        <Button
          variant="outline"
          size="xs"
          className={`${GIT_ACTION_BUTTON_CLASS} rounded-r-none border-r-0`}
          disabled={primaryDisabled}
          onClick={() => primaryAction && onAction(primaryAction)}
          title={primaryDisabled ? (state.disabled.commit ?? state.label) : state.label}
        >
          <PrimaryIcon className="size-3.5" />
          <span>{state.label}</span>
        </Button>
      )}
      <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
        <ShortcutTooltip label="Git actions" keys={["cmd", "G"]}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={`${GIT_ACTION_BUTTON_CLASS} rounded-l-none px-1.5`}
              aria-label="More git actions"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </ShortcutTooltip>
        <PopoverContent align="end" className="w-80 p-0">
          <GitActionPopover state={state} commitActivity={commitActivity} onPick={onAction} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface CommitActivityButtonProps {
  activity: Exclude<CommitActivity, null>;
  className?: string;
  onClick: () => void;
}

function CommitActivityButton({
  activity,
  className,
  onClick,
}: CommitActivityButtonProps): ReactElement {
  const running = activity === "running";
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn(GIT_ACTION_BUTTON_CLASS, className)}
      onClick={onClick}
      aria-live="polite"
      title={running ? "View commit progress" : "View commit error"}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <CircleAlert className="size-3.5 text-destructive" />
      )}
      <span className={running ? undefined : "text-destructive"}>
        {running ? "Committing" : "Commit failed"}
      </span>
    </Button>
  );
}

interface GitActionShortcutOptions {
  state: GitActionState;
  commitActivity: CommitActivity;
  openCommit: () => void;
  openPush: () => void;
  openCompare: () => Promise<void>;
  openPopover: () => void;
}

function useGitActionShortcuts(options: GitActionShortcutOptions): void {
  useShortcut("git-commit", (event) => {
    if (isInCodeMirrorEditor(event.target)) return;
    if (!options.commitActivity && options.state.disabled.commit !== null) return;
    event.preventDefault();
    options.openCommit();
  });
  useShortcut("git-push", (event) => {
    if (options.state.disabled.push !== null) return;
    event.preventDefault();
    options.openPush();
  });
  useShortcut("git-pr", (event) => {
    if (options.state.disabled.pr !== null) return;
    event.preventDefault();
    void options.openCompare();
  });
  useGlobalShortcutById("git-actions", (event) => {
    event.preventDefault();
    options.openPopover();
  });
}
