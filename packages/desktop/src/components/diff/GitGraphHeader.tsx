import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  GitBranchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  selectGitAheadOfRemote,
  selectGitBehindRemote,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";

interface GitGraphHeaderProps {
  /** The feature whose remote standing to show, or `null` when the graph is
   *  another branch's: the checked-out branch's counts would describe
   *  something else. */
  syncFeatureId: number | null;
  currentBranch: string | null;
  /** The target drawn alongside the branch; `null` in a single-branch view. */
  targetBranch: string | null;
  onBackToBranches?: () => void;
}

/**
 * What the graph shows and where the branch stands against its remote.
 *
 * The sync status answers the question the list alone cannot: "is anything
 * still only on my machine?".
 */
export const GitGraphHeader = memo(function GitGraphHeader({
  syncFeatureId,
  currentBranch,
  targetBranch,
  onBackToBranches,
}: GitGraphHeaderProps): ReactElement {
  const { t } = useUiTranslation();
  const branch = currentBranch ?? "HEAD";
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
      {onBackToBranches && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onBackToBranches}
          className="-ml-1.5 font-normal text-muted-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          {t("workspace.git.gitGraphHeader.branches", "Branches")}
        </Button>
      )}
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5"
        title={
          targetBranch
            ? t(
                "workspace.git.gitGraphHeader.historyWithTarget",
                "History of {{branch}} and its target branch {{target}}",
                { branch, target: targetBranch },
              )
            : t("workspace.git.gitGraphHeader.history", "History of {{branch}}", { branch })
        }
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono font-medium text-foreground">{branch}</span>
        {targetBranch && (
          <>
            <ArrowRightIcon
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={t("workspace.git.gitGraphHeader.into", "into")}
            />
            <span className="truncate font-mono text-muted-foreground">{targetBranch}</span>
          </>
        )}
      </div>
      {syncFeatureId != null && <RemoteSyncStatus featureId={syncFeatureId} branch={branch} />}
    </div>
  );
});

function RemoteSyncStatus({
  featureId,
  branch,
}: {
  featureId: number;
  branch: string;
}): ReactElement | null {
  const { t } = useUiTranslation();
  const ahead = useGitStatusStore(selectGitAheadOfRemote(featureId));
  const behind = useGitStatusStore(selectGitBehindRemote(featureId));
  if (ahead === undefined || behind === undefined) return null;
  if (ahead === 0 && behind === 0) {
    return (
      <SyncLabel
        icon={<CheckIcon className="size-3.5" />}
        tone="muted"
        hint={t(
          "workspace.git.gitGraphHeader.everyCommitOnBranchIsOnThe",
          "Every commit on {{branch}} is on the remote",
          { branch: branch },
        )}
      >
        {t("workspace.git.gitGraphHeader.allPushed", "All pushed")}
      </SyncLabel>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-3">
      {ahead > 0 && (
        <SyncLabel
          icon={<ArrowUpIcon className="size-3.5" />}
          tone="local"
          hint={t(
            "workspace.git.gitGraphHeader.aheadHint",
            "{{count, number}} commits on {{branch}} not on the remote yet — push to share",
            {
              count: ahead,
              branch,
              defaultValue_one:
                "{{count, number}} commit on {{branch}} not on the remote yet — push to share",
            },
          )}
        >
          {t("workspace.git.gitGraphHeader.ahead", "{{count, number}} not pushed", {
            count: ahead,
          })}
        </SyncLabel>
      )}
      {behind > 0 && (
        <SyncLabel
          icon={<ArrowDownIcon className="size-3.5" />}
          tone="default"
          hint={t(
            "workspace.git.gitGraphHeader.behindHint",
            "The remote has {{count, number}} commits this branch does not — pull to catch up",
            {
              count: behind,
              defaultValue_one:
                "The remote has {{count, number}} commit this branch does not \u2014 pull to catch up",
            },
          )}
        >
          {t("workspace.git.gitGraphHeader.behind", "{{count, number}} to pull", { count: behind })}
        </SyncLabel>
      )}
    </div>
  );
}

const TONE_CLASS = {
  muted: "text-muted-foreground",
  default: "text-foreground",
  local: "font-medium text-[var(--acc-orange)]",
} as const;

function SyncLabel({
  icon,
  tone,
  hint,
  children,
}: {
  icon: ReactElement;
  tone: keyof typeof TONE_CLASS;
  hint: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums",
        TONE_CLASS[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}
