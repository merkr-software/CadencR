import type { ReactElement } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  GitBranchIcon,
  Loader2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

export interface WorktreeSetupHeaderProps {
  branch: string;
  branchExists: boolean | null;
  status: WorktreeSetupDisplayStatus;
  /** Shown as the status badge tooltip while setup has failed. */
  setupError?: string;
  isOpen: boolean;
  onToggle: () => void;
  className?: string;
}

export type WorktreeSetupDisplayStatus =
  | "running"
  | "checking"
  | "ready"
  | "removed"
  | "health-error"
  | "setup-error";

/**
 * One-line worktree summary on a two-column grid: the chevron in a leading
 * column, the branch row beside it. Unpadded — the feature header joins the
 * grid as a subgrid so the chevron shares its project-badge column.
 */
export function WorktreeSetupHeader({
  branch,
  branchExists,
  status,
  setupError,
  isOpen,
  onToggle,
  className,
}: WorktreeSetupHeaderProps): ReactElement {
  const missing = status === "removed" ? missingSummary(branchExists) : null;
  return (
    <div
      className={cn(
        "grid min-h-5 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 text-xs",
        className,
      )}
    >
      {/* Pointer twin of the branch toggle; its negative margins keep the
          leading column as narrow as the badge it sits under. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onToggle}
        className="-mx-0.5 flex justify-self-center text-foreground/40 hover:text-foreground/70"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform duration-200", isOpen && "rotate-90")}
        />
      </button>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={isOpen}
          title={branch || undefined}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          {branch ? (
            <>
              <span className="sr-only">Worktree setup</span>
              <span className="truncate font-mono">{branch}</span>
            </>
          ) : (
            <span className="truncate">Worktree setup</span>
          )}
        </button>
        {branch && (
          <CopyButton
            text={branch}
            label="Copy branch name"
            copiedLabel="Copied branch name"
            idleClassName="text-muted-foreground opacity-70"
            iconClassName="size-3"
            className="shrink-0 hover:text-foreground"
          />
        )}
        <WorktreeSetupBadge status={status} setupError={setupError} />
        {missing && (
          <span className="min-w-0 truncate text-destructive" title={missing}>
            {missing}
          </span>
        )}
      </div>
    </div>
  );
}

function WorktreeSetupBadge({
  status,
  setupError,
}: Pick<WorktreeSetupHeaderProps, "status" | "setupError">): ReactElement {
  const badge = badgeContent(status);
  return (
    <Badge
      variant="secondary"
      title={status === "setup-error" && setupError ? setupError : undefined}
      className={cn("shrink-0 gap-1 px-1.5 py-0 text-[10px]", badge.style)}
    >
      {badge.content}
    </Badge>
  );
}

function badgeContent(status: WorktreeSetupDisplayStatus): {
  content: ReactElement;
  style: string;
} {
  if (status === "removed") {
    return {
      content: (
        <>
          <AlertTriangleIcon className="size-2.5" /> removed
        </>
      ),
      style: "bg-destructive/15 text-destructive",
    };
  }
  if (status === "health-error") {
    return {
      content: (
        <>
          <AlertCircleIcon className="size-2.5" /> check failed
        </>
      ),
      style: "bg-destructive/15 text-destructive",
    };
  }
  if (status === "checking") {
    return {
      content: (
        <>
          <Loader2Icon className="size-2.5 animate-spin" /> checking
        </>
      ),
      style: "bg-muted text-muted-foreground",
    };
  }
  if (status === "ready") {
    return {
      content: (
        <>
          <CheckCircle2Icon className="size-2.5" /> ready
        </>
      ),
      style: "bg-green-500/15 text-green-400",
    };
  }
  if (status === "running") {
    return {
      content: (
        <>
          <Loader2Icon className="size-2.5 animate-spin" /> running
        </>
      ),
      style: "bg-blue-500/15 text-blue-400",
    };
  }
  return {
    content: (
      <>
        <AlertCircleIcon className="size-2.5" /> error
      </>
    ),
    style: "bg-red-500/15 text-red-400",
  };
}

function missingSummary(branchExists: boolean | null): string {
  if (branchExists === true) return "Folder removed; branch still exists";
  if (branchExists === false) return "Folder and branch removed";
  return "Folder removed; branch status unknown";
}
