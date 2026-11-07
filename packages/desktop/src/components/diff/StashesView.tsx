import { memo, useCallback, useMemo, useState, type ReactElement, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Loader2Icon, ArchiveIcon } from "lucide-react";
import { useListStashes, type StashEntry } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { GitRevisionDiffView } from "./GitRevisionDiffView";
import { useOpenDiffInEditor } from "./OpenDiffInEditorContext";
import { useGitPathEditorOpener } from "./useGitPathEditorOpener";
import { StashRow, STASH_ROW_HEIGHT } from "./StashRow";
import type { StashConflictHandler, StashConflictOpenHandler } from "./stash-contracts";
import { useStashMutationCoordinator } from "./useStashMutationCoordinator";
import { useVirtualizedListNavigation } from "@/hooks/useVirtualizedListNavigation";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import { useNestedGitListNavigation } from "./useNestedGitListNavigation";

export interface StashesViewProps {
  featureId: number;
  /** Route a recoverable apply/pop outcome to the Uncommitted Git view. */
  onConflicts?: StashConflictHandler;
  /** Optional Editor handoff override; defaults to the existing diff Editor context. */
  onOpenConflict?: StashConflictOpenHandler;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}

/**
 * Stashes view for the Git tab: the `git stash list` entries (reflog selector,
 * description, date and numstat). Clicking a stash opens its diff by reusing the
 * shared `commit_sha` diff pipeline — a stash is a commit, so `DiffViewer` with
 * `commitSha={stash.sha}` renders `git diff <sha>^..<sha>`, exactly the stashed
 * changes. Virtualized so a long stash list can't jank the streaming area.
 */
export const StashesView = memo(function StashesView({
  featureId,
  onConflicts,
  onOpenConflict,
  registerNavigationAdapter,
}: StashesViewProps): ReactElement {
  const [openedStash, setOpenedStash] = useState<StashEntry | null>(null);
  const handleCloseStash = useCallback((): void => setOpenedStash(null), []);
  const contextOpenConflict = useOpenDiffInEditor();
  const openConflict = useGitPathEditorOpener(featureId, onOpenConflict ?? contextOpenConflict);
  const mutationCoordinator = useStashMutationCoordinator(featureId);

  const { data, isLoading, isError, error, refetch } = useListStashes({
    feature_id: featureId,
  });
  const stashes = useMemo<StashEntry[]>(() => data ?? [], [data]);
  const listNavigation = useVirtualizedListNavigation(stashes, setOpenedStash);
  const registerDetailAdapter = useNestedGitListNavigation(
    {
      activeDetailId: openedStash?.ref_name ?? null,
      list: listNavigation.navigation,
      itemId: (stash) => stash.ref_name,
      closeDetail: handleCloseStash,
    },
    registerNavigationAdapter,
  );
  // The confirmed backend WS status follows the merged invalidation path. This
  // explicit refetch only lets the row wait for deterministic reflog ordinals;
  // it never writes or removes cached stashes itself.
  const refreshStashes = useCallback(async (): Promise<void> => {
    await refetch({ throwOnError: true });
  }, [refetch]);

  const itemContent = useCallback(
    (index: number): ReactElement => {
      const stash = stashes[index];
      if (!stash) return <div style={{ height: STASH_ROW_HEIGHT }} />;
      return (
        <StashRow
          featureId={featureId}
          stash={stash}
          active={index === listNavigation.activeIndex}
          onOpen={() => {
            listNavigation.navigation.openIndex(index);
          }}
          onConflicts={onConflicts}
          onOpenConflict={openConflict}
          onRefresh={refreshStashes}
          coordinator={mutationCoordinator}
        />
      );
    },
    [
      featureId,
      listNavigation.activeIndex,
      listNavigation.navigation,
      mutationCoordinator,
      onConflicts,
      openConflict,
      refreshStashes,
      stashes,
    ],
  );

  if (openedStash) {
    return (
      <GitRevisionDiffView
        featureId={featureId}
        revision={openedStash.sha}
        backLabel="Stashes"
        label={openedStash.ref_name}
        message={openedStash.message}
        onBack={handleCloseStash}
        registerNavigationAdapter={registerDetailAdapter}
      />
    );
  }

  return (
    <StashListBody
      stashes={stashes}
      isLoading={isLoading}
      isError={isError}
      error={error}
      itemContent={itemContent}
      viewportRef={listNavigation.viewportRef}
      virtuosoRef={listNavigation.virtuosoRef}
    />
  );
});

function StashListBody({
  stashes,
  isLoading,
  isError,
  error,
  itemContent,
  viewportRef,
  virtuosoRef,
}: {
  stashes: StashEntry[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  itemContent: (index: number) => ReactElement;
  viewportRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}): ReactElement {
  if (isLoading && stashes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading stashes…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
        {apiErrorMessage(error, "Could not load stashes")}
      </div>
    );
  }
  if (stashes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <ArchiveIcon className="size-5" />
        No stashes.
      </div>
    );
  }
  return (
    <div ref={viewportRef} className="h-full">
      <Virtuoso
        ref={virtuosoRef}
        style={{ height: "100%" }}
        totalCount={stashes.length}
        itemContent={itemContent}
        increaseViewportBy={STASH_ROW_HEIGHT * 6}
      />
    </div>
  );
}
