import { Loader2Icon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import { useId, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PrViewError } from "@/components/FeaturePrViewParts";
import { PrCommentsFilterToggle, type PrCommentFilter } from "@/components/PrCommentsFilter";
import { EYEBROW_TEXT_CLASS } from "@/components/SidebarBlock";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";

export interface CommentsHeaderProps {
  commentsLoading: boolean;
  commentsRefreshing: boolean;
  commentsError: string | undefined;
  onRetry: () => void;
  /** Threads currently listed, i.e. after the filter is applied. */
  commentCount: number;
  unresolvedCount: number;
  totalCount: number;
  filter: PrCommentFilter;
  onFilterChange: (next: PrCommentFilter) => void;
  selectionEnabled?: boolean;
  selectedCount?: number;
  onAllSelectedChange?: (selected: boolean) => void;
}

/**
 * The threads section's one header row: what you are looking at, and the single
 * control that takes all of it. Everything the old version explained in prose —
 * what the checkbox column is for, where the send button lives, how many are
 * picked — is now said once, by the action bar that actually does it.
 */
export function CommentsHeader({
  commentsLoading,
  commentsRefreshing,
  commentsError,
  onRetry,
  commentCount,
  unresolvedCount,
  totalCount,
  filter,
  onFilterChange,
  selectionEnabled = false,
  selectedCount = 0,
  onAllSelectedChange,
}: CommentsHeaderProps): ReactElement {
  const showFilter = !commentsLoading && !commentsError && totalCount > 0;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className={EYEBROW_TEXT_CLASS}>Review threads</h3>
        {commentsLoading && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            role="status"
          >
            <Loader2Icon className="size-3 animate-spin" aria-hidden /> Loading…
          </span>
        )}
        {/*
          One `ml-auto`, on the group: two of them as siblings share the free
          space between themselves, which left the filter stranded mid-row
          instead of grouped with the control it belongs beside.
        */}
        <div className="ml-auto flex items-center gap-2">
          {showFilter && (
            <PrCommentsFilterToggle
              value={filter}
              unresolvedCount={unresolvedCount}
              totalCount={totalCount}
              onChange={onFilterChange}
            />
          )}
          {selectionEnabled && onAllSelectedChange && (
            <SelectAllThreads
              unresolvedCount={unresolvedCount}
              selectedCount={selectedCount}
              onAllSelectedChange={onAllSelectedChange}
            />
          )}
        </div>
      </div>
      {commentsError && (
        <CommentsError
          message={commentsError}
          isRefreshing={commentsRefreshing}
          onRetry={onRetry}
        />
      )}
      {!commentsLoading && !commentsError && commentCount === 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {totalCount === 0
            ? "No review threads yet."
            : "Nothing unresolved — every review thread on this proposal is resolved."}
        </p>
      )}
    </section>
  );
}

/**
 * Tri-state on purpose: after ticking a few threads by hand, a plain unchecked
 * box would read as "nothing picked".
 */
function SelectAllThreads({
  unresolvedCount,
  selectedCount,
  onAllSelectedChange,
}: {
  unresolvedCount: number;
  selectedCount: number;
  onAllSelectedChange: (selected: boolean) => void;
}): ReactElement {
  const selectAllId = useId();
  const allSelected = selectedCount === unresolvedCount;
  const checked: boolean | "indeterminate" = allSelected
    ? true
    : selectedCount > 0
      ? "indeterminate"
      : false;
  return (
    <label
      htmlFor={selectAllId}
      /* Foreground, not muted: this is a control's label, and `muted` on the
         dark card measures ~2.9:1 at this size. Same 11px medium as the
         filter beside it, so the row's two controls read as one set. */
      className="-my-1 flex cursor-pointer items-center gap-2 py-1 text-[11px] font-medium text-foreground"
      title={allSelected ? "Clear every thread" : `Pick all ${unresolvedCount} unresolved threads`}
    >
      <Checkbox
        id={selectAllId}
        checked={checked}
        onCheckedChange={() => onAllSelectedChange(!allSelected)}
        aria-label={`Pick all ${unresolvedCount} unresolved threads for the agent`}
      />
      Pick all
    </label>
  );
}

function CommentsError({
  message,
  isRefreshing,
  onRetry,
}: {
  message: string;
  isRefreshing: boolean;
  onRetry: () => void;
}): ReactElement {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-56 flex-1">
        <PrViewError message={message} compact />
      </div>
      <Button variant="outline" size="xs" disabled={isRefreshing} onClick={onRetry}>
        {isRefreshing ? (
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
        ) : (
          <RefreshCwIcon className="size-3" aria-hidden />
        )}
        Retry
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          void navigate({ to: "/settings", search: { section: FORGE_SETTINGS_ANCHOR } })
        }
      >
        <Settings2Icon className="size-3" aria-hidden />
        Git settings
      </Button>
    </div>
  );
}
