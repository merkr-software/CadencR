import { useMemo, type ReactElement } from "react";
import type { Components } from "react-virtuoso";
import type { CommentThread, PrStatusSnapshot } from "@/api/generated";
import type { PrCommentFilter } from "@/components/PrCommentsFilter";
import { CommentsHeader, type CommentsHeaderProps } from "@/components/PrCommentsHeader";
import { PrDescription } from "@/components/FeaturePrViewParts";

/** The slice of the PR timeline's props that its header is built from. */
export interface TimelineHeaderSource {
  status: PrStatusSnapshot;
  /** Threads currently listed, i.e. after the filter is applied. */
  threads: CommentThread[];
  unresolvedCount: number;
  totalCount: number;
  filter: PrCommentFilter;
  onFilterChange: (next: PrCommentFilter) => void;
  commentsLoading: boolean;
  commentsRefreshing: boolean;
  commentsError: string | undefined;
  onCommentsRetry: () => void;
  selectedThreadIds?: ReadonlySet<string>;
  onThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  onAllThreadsSelectedChange?: (selected: boolean) => void;
}

/** Exactly what the list's header renders — see {@link useTimelineContext}. */
export type TimelineContext = CommentsHeaderProps & { status: PrStatusSnapshot };

/**
 * The header's props, narrowed and memoized.
 *
 * Virtuoso hands `context` to the header *and* to every rendered item, so
 * passing the timeline's whole props object would re-render every visible thread
 * card whenever any unrelated field changed — a refresh flag flipping, say.
 * Listing the fields the header actually reads keeps the cards out of it.
 */
export function useTimelineContext(props: TimelineHeaderSource): TimelineContext {
  const { unresolvedCount, onThreadSelectedChange } = props;
  const selectedCount = props.selectedThreadIds?.size ?? 0;
  return useMemo(
    () => ({
      status: props.status,
      commentsLoading: props.commentsLoading,
      commentsRefreshing: props.commentsRefreshing,
      commentsError: props.commentsError,
      onRetry: props.onCommentsRetry,
      commentCount: props.threads.length,
      unresolvedCount,
      totalCount: props.totalCount,
      filter: props.filter,
      onFilterChange: props.onFilterChange,
      selectionEnabled: onThreadSelectedChange != null && unresolvedCount > 0,
      selectedCount,
      onAllSelectedChange: props.onAllThreadsSelectedChange,
    }),
    [
      onThreadSelectedChange,
      props.commentsError,
      props.commentsLoading,
      props.commentsRefreshing,
      props.filter,
      props.onAllThreadsSelectedChange,
      props.onCommentsRetry,
      props.onFilterChange,
      props.status,
      props.threads.length,
      props.totalCount,
      selectedCount,
      unresolvedCount,
    ],
  );
}

function TimelineHeader({ context }: { context?: TimelineContext }): ReactElement | null {
  if (!context) return null;
  const { status, ...header } = context;
  return (
    <div className="space-y-3 px-4 pb-3 pt-3">
      <PrDescription status={status} />
      <CommentsHeader {...header} />
    </div>
  );
}

/**
 * The list's non-item slots.
 *
 * Declared once at module scope rather than rebuilt per render: a fresh `Header`
 * *function identity* is a different component type to React, so it unmounts and
 * remounts the whole subtree. That cost the select-all checkbox its DOM node —
 * and therefore keyboard focus — on every single tick, and re-ran the
 * description's markdown render with it.
 */
export const TIMELINE_COMPONENTS = {
  // The list ends against the send bar, which is a hard edge with its own
  // border. Without this the last card looks wedged under it.
  Footer: () => <div className="h-3" />,
  Header: TimelineHeader,
} satisfies Components<CommentThread, TimelineContext>;
