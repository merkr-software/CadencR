import { useCallback, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getCommitUrl,
  useGetCommitGraph,
  type BranchInfo,
  type CommitGraphEntry,
  type GetCommitGraphParams,
} from "@/api/generated";
import { useVirtualizedListNavigation } from "@/hooks/useVirtualizedListNavigation";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { computeGraphLayout, type GraphCommitInput } from "@/lib/git-graph-layout";
import type { GitGraphRowData } from "./GitGraphRow";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import { useNestedGitListNavigation } from "./useNestedGitListNavigation";

const PAGE_SIZE = 50;

function toGraphRows(commits: CommitGraphEntry[]): GitGraphRowData[] {
  return commits.map((commit) => ({
    sha: commit.sha,
    shortSha: commit.short_sha,
    message: commit.message,
    body: commit.body,
    author: commit.author,
    date: commit.date,
    isPushed: commit.is_pushed,
    parents: commit.parents,
    decorations: commit.decorations,
    filesChanged: commit.files_changed,
    additions: commit.additions,
    deletions: commit.deletions,
  }));
}

function useOpenCommitOnline(featureId: number): (sha: string) => Promise<void> {
  return useCallback(
    async (sha: string) => {
      try {
        const response = await getCommitUrl({ feature_id: featureId, sha });
        if (!response.available || !response.url) {
          toast.error("No remote host is configured for this repository.");
          return;
        }
        await desktopBridge.openExternal(response.url);
      } catch (error) {
        const message = apiErrorMessage(error, "Unknown error");
        toast.error(`Could not open the commit online: ${message}`);
      }
    },
    [featureId],
  );
}

export function useGitGraphViewModel({
  featureId,
  branch,
  onBackToBranches,
  registerNavigationAdapter,
}: {
  featureId: number;
  branch?: Pick<BranchInfo, "name" | "is_local">;
  onBackToBranches?: () => void;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [openedCommit, setOpenedCommit] = useState<string | null>(null);
  const params = useMemo<GetCommitGraphParams>(
    () => ({
      feature_id: featureId,
      branch: branch?.name,
      branch_is_local: branch?.is_local,
      skip: 0,
      limit,
    }),
    [branch, featureId, limit],
  );
  const query = useGetCommitGraph(params, { query: { placeholderData: keepPreviousData } });
  const commits = useMemo(() => toGraphRows(query.data?.commits ?? []), [query.data]);
  const openCommit = useCallback(
    (commit: GitGraphRowData): void => setOpenedCommit(commit.sha),
    [],
  );
  const list = useVirtualizedListNavigation(commits, openCommit);
  const layout = useMemo(() => {
    const inputs: GraphCommitInput[] = commits.map((commit) => ({
      sha: commit.sha,
      parents: commit.parents,
    }));
    return computeGraphLayout(inputs);
  }, [commits]);
  const hasMore = query.data?.has_more ?? false;
  const endReached = useCallback(() => {
    if (hasMore) setLimit((current) => current + PAGE_SIZE);
  }, [hasMore]);
  const closeCommit = useCallback((): void => setOpenedCommit(null), []);
  const openedEntry = openedCommit
    ? (commits.find((entry) => entry.sha === openedCommit) ?? null)
    : null;
  const registerDetailAdapter = useNestedGitListNavigation(
    {
      activeDetailId: openedCommit,
      list: list.navigation,
      itemId: (entry) => entry.sha,
      closeDetail: closeCommit,
      backFromList: onBackToBranches,
    },
    registerNavigationAdapter,
  );
  const openOnline = useOpenCommitOnline(featureId);
  return useMemo(
    () => ({
      query,
      commits,
      layout,
      hasMore,
      openedCommit,
      openedEntry,
      list,
      endReached,
      closeCommit,
      openOnline,
      registerDetailAdapter,
    }),
    [
      closeCommit,
      commits,
      endReached,
      hasMore,
      layout,
      list,
      openOnline,
      openedCommit,
      openedEntry,
      query,
      registerDetailAdapter,
    ],
  );
}
