import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { Loader2Icon, GitBranchIcon, ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { getCommitUrl, useGetCommitGraph } from "@/api/generated";
import { desktopBridge } from "@/lib/desktop-bridge";
import { computeGraphLayout, type GraphCommitInput } from "@/lib/git-graph-layout";
import { DiffViewer } from "./DiffViewer";
import { GitGraphRow, ROW_HEIGHT, type GitGraphRowData } from "./GitGraphRow";

const PAGE_SIZE = 50;

interface GitGraphViewProps {
  featureId: number;
}

/**
 * Graph view for the Git tab: a `git log --graph`-style list of commits on the
 * current branch unioned with its (local) target, so the divergence point is
 * visible. Clicking a commit opens its full diff; right-click offers "open
 * online". Virtualized and paginated via infinite scroll.
 */
export const GitGraphView = memo(function GitGraphView({
  featureId,
}: GitGraphViewProps): ReactElement {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [openedCommit, setOpenedCommit] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useGetCommitGraph(
    { feature_id: featureId, skip: 0, limit },
    { query: { keepPreviousData: true } },
  );

  const commits = useMemo<GitGraphRowData[]>(
    () =>
      (data?.commits ?? []).map((c) => ({
        sha: c.sha,
        shortSha: c.short_sha,
        message: c.message,
        body: c.body,
        author: c.author,
        date: c.date,
        isPushed: c.is_pushed,
        parents: c.parents,
        refs: c.refs,
        filesChanged: c.files_changed,
        additions: c.additions,
        deletions: c.deletions,
      })),
    [data],
  );

  const layout = useMemo(() => {
    const inputs: GraphCommitInput[] = commits.map((c) => ({ sha: c.sha, parents: c.parents }));
    return computeGraphLayout(inputs);
  }, [commits]);

  const hasMore = data?.has_more ?? false;
  const handleEndReached = useCallback(() => {
    if (hasMore) setLimit((l) => l + PAGE_SIZE);
  }, [hasMore]);

  // Always hand Virtuoso a components object — passing `undefined` overwrites its
  // internal default (`{}`) and makes it crash reading `components.EmptyPlaceholder`.
  const components = useMemo(() => (hasMore ? { Footer: GraphFooter } : {}), [hasMore]);

  const handleOpenOnline = useCallback(
    async (sha: string) => {
      try {
        const res = await getCommitUrl({ feature_id: featureId, sha });
        if (!res.available || !res.url) {
          toast.error("No remote host is configured for this repository.");
          return;
        }
        await desktopBridge.openExternal(res.url);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        toast.error(`Could not open the commit online: ${message}`);
      }
    },
    [featureId],
  );

  const itemContent = useCallback(
    (index: number): ReactElement => {
      const commit = commits[index];
      const row = layout.rows[index];
      if (!commit || !row) return <div style={{ height: ROW_HEIGHT }} />;
      return (
        <GitGraphRow
          commit={commit}
          row={row}
          columns={layout.columns}
          onOpenCommit={setOpenedCommit}
          onOpenOnline={handleOpenOnline}
        />
      );
    },
    [commits, layout, handleOpenOnline],
  );

  // ---- Single-commit diff overlay ----
  if (openedCommit) {
    const commit = commits.find((c) => c.sha === openedCommit);
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setOpenedCommit(null)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Graph
          </button>
          <span className="shrink-0 font-mono text-xs text-primary">
            {commit?.shortSha ?? openedCommit.slice(0, 7)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{commit?.message}</span>
          <button
            type="button"
            onClick={() => void handleOpenOnline(openedCommit)}
            title="Open commit online"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffViewer featureId={featureId} mode="worktree" commitSha={openedCommit} />
        </div>
      </div>
    );
  }

  if (isLoading && commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading commit graph…
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Could not load the commit graph";
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
        {message}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <GitBranchIcon className="size-5" />
        No commits to show.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GraphHeader
        currentBranch={data?.current_branch ?? null}
        targetBranch={data?.target_branch ?? null}
      />
      <div className="min-h-0 flex-1">
        <Virtuoso
          style={{ height: "100%" }}
          totalCount={commits.length}
          itemContent={itemContent}
          endReached={handleEndReached}
          increaseViewportBy={ROW_HEIGHT * 6}
          components={components}
        />
      </div>
    </div>
  );
});

function GraphHeader({
  currentBranch,
  targetBranch,
}: {
  currentBranch: string | null;
  targetBranch: string | null;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-foreground">{currentBranch ?? "HEAD"}</span>
      {targetBranch && (
        <>
          <span className="shrink-0 text-muted-foreground">vs</span>
          <span className="truncate font-mono text-muted-foreground">{targetBranch}</span>
        </>
      )}
    </div>
  );
}

function GraphFooter(): ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
      <Loader2Icon className="size-3 animate-spin" />
      Loading more…
    </div>
  );
}
