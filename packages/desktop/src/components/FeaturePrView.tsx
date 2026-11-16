import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type WheelEvent,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useNavigate } from "@tanstack/react-router";
import { useGetPr, type CommentThread } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { DEFAULT_PR_COMMENT_FILTER, type PrCommentFilter } from "@/components/PrCommentsFilter";
import type { PrReviewThreads } from "@/hooks/usePrReviewThreads";
import { useViewedPr, type ViewedPr } from "@/hooks/useViewedPr";
import { apiErrorMessage } from "@/lib/api-errors";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { hydratePrStatuses } from "@/stores/pr-status-hydration";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { PrCommentThread } from "@/components/FeaturePrComments";
import {
  EmptyState,
  PrEmptyIcon,
  PrViewError,
  PrViewLoading,
} from "@/components/FeaturePrViewParts";
import { ForgeImageScope } from "@/components/ForgeImage";
import { PrStatusBand } from "@/components/PrStatusBand";
import { PrSwitcher } from "@/components/PrSwitcher";
import { snapshotForPr } from "@/lib/thread-prs";
import {
  TIMELINE_COMPONENTS,
  useTimelineContext,
  type TimelineHeaderSource,
} from "@/components/PrTimelineSlots";
import type { GitNavigationAdapterRegistrar } from "@/components/diff/gitNavigation";
import { usePrThreadKeyboard } from "@/components/diff/usePrThreadKeyboard";

interface FeaturePrViewProps {
  featureId: number;
  reviews: PrReviewThreads;
  selectedThreadIds?: ReadonlySet<string>;
  onThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  onAllThreadsSelectedChange?: (selected: boolean) => void;
  onViewThread?: (thread: CommentThread) => void;
  onSendThread?: (thread: CommentThread) => void;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}

export const FeaturePrView = memo(function FeaturePrView({
  featureId,
  reviews,
  selectedThreadIds,
  onThreadSelectedChange,
  onAllThreadsSelectedChange,
  onViewThread,
  onSendThread,
  registerNavigationAdapter,
}: FeaturePrViewProps): ReactElement {
  const cached = usePrStatusStore(selectPrStatus(featureId));
  const summaryQuery = useGetPr(
    { feature_id: featureId },
    { query: { enabled: cached === undefined, retry: false } },
  );
  const status = cached ?? summaryQuery.data;
  const viewedPr = useViewedPr(featureId, status);
  const [filter, setFilter] = useState<PrCommentFilter>(DEFAULT_PR_COMMENT_FILTER);

  if (summaryQuery.isLoading && !status) return <PrViewLoading />;
  if (summaryQuery.isError && !status) {
    return (
      <PrViewError
        message={apiErrorMessage(summaryQuery.error, "Could not load pull request status")}
      />
    );
  }
  if (status?.setup_required) return <ForgeConnectEmptyState reason={status.error} />;
  const { viewed } = viewedPr;
  if (!status || !viewed) {
    return (
      <WithSwitcher viewedPr={viewedPr}>
        {status?.error ? <PrViewError message={status.error} /> : <NoPrEmptyState />}
      </WithSwitcher>
    );
  }

  // Everything below here — the description, every comment body, every author's
  // face — reaches its images through this feature's forge. Scoped once at the
  // top rather than per card, because a thread's markdown is rendered several
  // layers down inside Virtuoso and would otherwise have to carry the id.
  return (
    <ForgeImageScope featureId={featureId}>
      <WithSwitcher viewedPr={viewedPr}>
        <PrTimeline
          // A fresh timeline per proposal: scroll position, keyboard focus and
          // the open check list all belong to the one being read.
          key={viewed.pr.number}
          status={snapshotForPr(status, viewed)}
          threads={filter === "unresolved" ? reviews.unresolved : reviews.threads}
          unresolvedCount={reviews.unresolvedCount}
          totalCount={reviews.threads.length}
          filter={filter}
          onFilterChange={setFilter}
          commentsLoading={reviews.isLoading}
          commentsRefreshing={reviews.isRefreshing}
          commentsError={reviews.errorMessage}
          onCommentsRetry={reviews.retry}
          selectedThreadIds={selectedThreadIds}
          onThreadSelectedChange={onThreadSelectedChange}
          onAllThreadsSelectedChange={onAllThreadsSelectedChange}
          // Another branch's threads anchor to a diff this pane can't show.
          onViewThread={viewed.isCurrent ? onViewThread : undefined}
          onSendThread={onSendThread}
          registerNavigationAdapter={registerNavigationAdapter}
        />
      </WithSwitcher>
    </ForgeImageScope>
  );
});

/** The pane's body under the proposal tabs, when there is more than one to pick. */
function WithSwitcher({
  viewedPr,
  children,
}: {
  viewedPr: ViewedPr;
  children: ReactElement;
}): ReactElement {
  if (viewedPr.tabs.length === 0) return children;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PrSwitcher tabs={viewedPr.tabs} selected={viewedPr.selected} onSelect={viewedPr.select} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

interface PrTimelineProps extends TimelineHeaderSource {
  onViewThread?: (thread: CommentThread) => void;
  onSendThread?: (thread: CommentThread) => void;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}

/**
 * Identity and verdict stay pinned above the scroller — reading the fortieth
 * thread should never cost you the answer to "which proposal is this, and is it
 * green?". Only the description and the threads scroll.
 */
function PrTimeline(props: PrTimelineProps): ReactElement {
  const band = usePinnedBandScroll();
  const {
    selectedThreadIds,
    onThreadSelectedChange,
    onViewThread,
    onSendThread,
    status,
    threads,
    onFilterChange,
  } = props;
  const listContext = useTimelineContext(props);
  const { focusedThreadId } = usePrThreadKeyboard({
    threads,
    register: props.registerNavigationAdapter,
    onViewThread,
    onSelectedChange: onThreadSelectedChange,
    selectedThreadIds,
    scrollHalfPage: band.scrollHalfPage,
    revealThread: band.revealThread,
  });

  const itemContent = useCallback(
    (_index: number, thread: CommentThread) => (
      <div className="pb-2.5">
        <PrCommentThread
          thread={thread}
          selected={selectedThreadIds?.has(thread.id) ?? false}
          focused={focusedThreadId === thread.id}
          onSelectedChange={onThreadSelectedChange}
          onViewThread={onViewThread}
          onSendThread={onSendThread}
        />
      </div>
    ),
    [focusedThreadId, onSendThread, onThreadSelectedChange, onViewThread, selectedThreadIds],
  );

  // "Refresh from the forge" used to refetch only the review threads, while the
  // band around the button shows checks, state, verdict and "updated N ago" —
  // all of which come from the status store. Clicking it because the checks
  // looked stale changed nothing visible. `hydratePrStatuses` reports its own
  // failures, so an unreachable forge still surfaces.
  const onCommentsRetry = props.onCommentsRetry;
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const refresh = useCallback((): void => {
    onCommentsRetry();
    setStatusRefreshing(true);
    void hydratePrStatuses().finally(() => setStatusRefreshing(false));
  }, [onCommentsRetry]);

  // A real toggle, because "unresolved" is the default filter: as a one-way
  // action the chip rendered pressed from the first frame and its click did
  // nothing, which is a control that lies about being one.
  const filter = props.filter;
  const toggleUnresolved = useCallback((): void => {
    onFilterChange(filter === "unresolved" ? "all" : "unresolved");
    band.scrollToTop();
  }, [band, filter, onFilterChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {status.error && (
        <div className="shrink-0 px-4 pt-3">
          <PrViewError message={status.error} compact />
        </div>
      )}
      <PrStatusBand
        status={status}
        unresolvedCount={props.unresolvedCount}
        unresolvedFiltered={filter === "unresolved"}
        onToggleUnresolved={toggleUnresolved}
        onRefresh={refresh}
        isRefreshing={props.commentsRefreshing || statusRefreshing}
        onWheel={band.onWheel}
      />
      <Virtuoso
        ref={band.listRef}
        // The well: one step below the pane colour the band and the send bar
        // sit on, so the thread cards (`bg-card`) lift off it. On one shared
        // surface the cards were separated by their hairlines alone.
        className="min-h-0 flex-1 bg-background"
        data={threads}
        context={listContext}
        components={TIMELINE_COMPONENTS}
        itemContent={itemContent}
        increaseViewportBy={400}
        scrollerRef={band.scrollerRef}
      />
    </div>
  );
}

/**
 * A wheel delta in the scroller's own units. Browsers report lines (Firefox) or
 * pages as readily as pixels, and treating a 3-line scroll as 3px would leave
 * the band feeling dead — the very thing forwarding the gesture is there to fix.
 */
function wheelPixels(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * viewportHeight;
  return deltaY;
}

/**
 * The pinned band is not scrollable, so a wheel gesture over it would land
 * nowhere and read as a frozen pane. Forwarding it to the list's scroller keeps
 * the whole pane feeling like one surface — and gives the keyboard commands
 * and the "show unresolved" chip the same handle to drive.
 */
function usePinnedBandScroll(): {
  listRef: React.RefObject<VirtuosoHandle | null>;
  scrollerRef: (element: HTMLElement | Window | null) => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  scrollHalfPage: (direction: -1 | 1) => boolean;
  scrollToTop: () => void;
  revealThread: (index: number) => void;
} {
  const scroller = useRef<HTMLElement | null>(null);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    scroller.current = element instanceof HTMLElement ? element : null;
  }, []);
  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element || event.deltaY === 0) return;
    element.scrollTop += wheelPixels(event.deltaY, event.deltaMode, element.clientHeight);
  }, []);
  const scrollHalfPage = useCallback((direction: -1 | 1): boolean => {
    const element = scroller.current;
    if (!element) return false;
    element.scrollBy({ top: (element.clientHeight / 2) * direction, behavior: "auto" });
    return true;
  }, []);
  const scrollToTop = useCallback((): void => {
    // The scroller, not `scrollToIndex(0)`: the first item is not the top of the
    // pane — the description and the threads header ride in Virtuoso's header,
    // and aligning item 0 to the start scrolls both of them out of sight.
    const element = scroller.current;
    if (element) element.scrollTop = 0;
  }, []);
  // `scrollIntoView`, not `scrollToIndex`: it handles a row the virtualizer has
  // not rendered *and* leaves an already-visible row where it is, so keyboard
  // focus stops re-centring cards you can already see.
  const revealThread = useCallback((index: number): void => {
    listRef.current?.scrollIntoView({ index });
  }, []);
  return useMemo(
    () => ({ listRef, scrollerRef, onWheel, scrollHalfPage, scrollToTop, revealThread }),
    [onWheel, revealThread, scrollHalfPage, scrollToTop, scrollerRef],
  );
}

/**
 * The pane's onboarding state: this feature has a remote, but the forge behind
 * it isn't usable yet. The button is the point — the fix lives in a card partway
 * down a different route, which nobody finds from an error saying "in Settings".
 *
 * `reason` goes in the detail slot rather than the description because it is not
 * always prose: a rejected call carries the forge's own body, which can be JSON.
 */
function ForgeConnectEmptyState({ reason }: { reason?: string | null }): ReactElement {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Connect this remote"
      // Deliberately not a second "…to load pull requests, checks, and comments":
      // the backend's reason already says that, and the two stacked read as a
      // stutter. This line states the situation, `detail` gives the specifics.
      description="Cadencr can't reach the forge behind this remote yet."
      detail={reason}
      icon={<PrEmptyIcon />}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({ to: "/settings", search: { section: FORGE_SETTINGS_ANCHOR } })
          }
        >
          Connect a provider
        </Button>
      }
    />
  );
}

function NoPrEmptyState(): ReactElement {
  return (
    <EmptyState
      title="No open pull request"
      description="Push this branch and open a pull request or merge request to see its summary here."
      icon={<PrEmptyIcon />}
    />
  );
}
