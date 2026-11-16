import { ExternalLinkIcon, GitCompareArrowsIcon, Loader2Icon, SendIcon } from "lucide-react";
import { memo, useCallback, useId, useState, type ReactElement } from "react";
import type { CommentThread } from "@/api/generated";
import { relativeTime } from "@/components/FeaturePrViewParts";
import { ForgeAvatar } from "@/components/ForgeImage";
import { Markdown } from "@/components/Markdown";
import { PR_MARKDOWN_CLASS } from "@/components/pr-markdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { openExternalUrl } from "@/lib/open-external";
import { isThreadAnchored, threadExternalHost, threadLocation } from "@/lib/pr-review-threads";
import { cn } from "@/lib/utils";

export interface PrCommentThreadProps {
  thread: CommentThread;
  selected?: boolean;
  /** Keyboard focus, which is not selection — j/k move it, `x` picks. */
  focused?: boolean;
  /**
   * Takes the thread id rather than closing over it, so the list can hand every
   * card one shared callback. Binding per card upstream produced a fresh arrow
   * for every row on every keystroke, which defeated this component's `memo`
   * exactly when `j`/`k` made it matter.
   */
  onSelectedChange?: (threadId: string, selected: boolean) => void;
  onViewThread?: (thread: CommentThread) => void;
  onSendThread?: (thread: CommentThread) => void;
}

/**
 * One review thread.
 *
 * Deliberately one surface rather than the header-band / body / footer-band
 * stack it replaced: three tinted strips inside a card inside a scroller read as
 * chrome, and the thread is the content. What is left is a location line, the
 * conversation, and the three things you can do about it.
 */
export const PrCommentThread = memo(function PrCommentThread({
  thread,
  selected = false,
  focused = false,
  onSelectedChange,
  onViewThread,
  onSendThread,
}: PrCommentThreadProps): ReactElement {
  const selectable = thread.resolved !== true && onSelectedChange != null;
  const threadId = thread.id;
  const handleSelectedChange = useCallback(
    (next: boolean): void => onSelectedChange?.(threadId, next),
    [onSelectedChange, threadId],
  );
  // No scroll-into-view here: the list owns revealing the focused row, and a
  // card that nudged itself as well raced it — the list would place a row the
  // virtualizer had just mounted, then the card would move it again.
  return (
    <article
      data-thread-id={thread.id}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      className={cn(
        // Gap below each card is the row wrapper's padding, not a margin here:
        // Virtuoso measures item wrappers with `getBoundingClientRect`, which
        // excludes margins, so a margin would leave the list short by one gap
        // per card — and the last card flush against the bottom edge.
        "mx-4 rounded-lg border bg-card px-3.5 py-3",
        "transition-[border-color,box-shadow,background-color] duration-150",
        selected ? "border-primary/60 bg-primary/[0.04]" : "border-border",
        focused && "ring-2 ring-ring/70",
        // A card the keyboard can land on needs a stable scroll anchor; a
        // thread taller than the viewport otherwise parks with its top clipped.
        "scroll-mt-2",
      )}
    >
      <ThreadHeader
        thread={thread}
        selected={selected}
        onSelectedChange={selectable ? handleSelectedChange : undefined}
      />
      {/*
        Fade the conversation only: putting opacity on the card also dimmed the
        status pill that says *why* the thread is settled (resolved → 2.5:1).
      */}
      <div className={cn("mt-2 space-y-3", thread.resolved && "opacity-70")}>
        {thread.comments.map((comment, index) => (
          <div
            key={`${comment.created_at}:${index}`}
            className={cn(index > 0 && "border-t border-border/60 pt-3")}
          >
            <div className="flex min-w-0 items-center gap-x-2 text-[11px] text-muted-foreground">
              <ForgeAvatar user={comment.author} />
              <span className="truncate text-[12px] font-semibold text-foreground">
                {comment.author.display_name ?? comment.author.username}
              </span>
              <span className="shrink-0 tabular-nums">{relativeTime(comment.created_at)}</span>
            </div>
            <Markdown
              content={comment.body_markdown}
              cacheKey={`${thread.id}:${comment.created_at}:${index}`}
              className={THREAD_MARKDOWN_CLASS}
            />
          </div>
        ))}
      </div>
      <ThreadActions thread={thread} onViewThread={onViewThread} onSendThread={onSendThread} />
    </article>
  );
});

/** Body text of every comment; `max-w-prose` keeps a wide pane from running lines edge to edge. */
const THREAD_MARKDOWN_CLASS = cn(PR_MARKDOWN_CLASS, "mt-1.5 max-w-prose");

/**
 * The thread's own facts, above its conversation: where it is anchored, whether
 * it is settled, and the box that picks it for the agent. Thread-level rather
 * than riding the first comment's author line — a long `path:line` there
 * wrapped the pick box onto a stranded, right-aligned second line at ordinary
 * pane widths.
 */
function ThreadHeader({
  thread,
  selected,
  onSelectedChange,
}: {
  thread: CommentThread;
  selected: boolean;
  onSelectedChange?: (selected: boolean) => void;
}): ReactElement {
  const selectionId = useId();
  const location = threadLocation(thread);
  const context = location && thread.side === "old" ? `${location} (removed side)` : location;
  const facts = (
    <>
      <span
        // Mono is for path:line; the "General comment" fallback stays proportional.
        className={cn("min-w-0 truncate", context && "font-mono")}
        title={context ?? undefined}
      >
        {context ?? "General comment"}
      </span>
      <ThreadStatusPills thread={thread} />
    </>
  );
  const rowClass = "flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground";
  if (!onSelectedChange) return <div className={rowClass}>{facts}</div>;
  // The whole row is the box's label, so the location — the widest thing on
  // it — is also the easiest place to click to pick the thread.
  return (
    <label
      htmlFor={selectionId}
      className={cn(rowClass, "-my-1 cursor-pointer py-1")}
      title="Pick this thread for the agent"
    >
      {facts}
      <Checkbox
        id={selectionId}
        checked={selected}
        onCheckedChange={(checked) => onSelectedChange(checked === true)}
        aria-label={`Pick ${context ?? "this general comment"} for the agent`}
        className="ml-auto shrink-0"
      />
    </label>
  );
}

/** Outdated / open / resolved markers, beside the location in the thread header. */
function ThreadStatusPills({ thread }: { thread: CommentThread }): ReactElement | null {
  if (!thread.outdated && thread.resolved == null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium">
      {/*
        Neutral pill, coloured dot — not coloured text on a tinted pill.
        A tint at these opacities pulls the surface *toward* the text's own hue,
        so it costs contrast rather than buying it: `--acc-orange` measures 4.45
        as a bare word on the light card and only 3.66 once tinted behind. The
        word rides `--muted`, where it clears 5:1 in every theme, and the dot
        carries the meaning — which is what the design system says colour is for
        anyway, and a dot is non-text, so 3:1 is the bar it has to clear.
      */}
      {thread.outdated && (
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
          title="The diff moved since this comment was written, so its line no longer points at the current code"
        >
          outdated
        </span>
      )}
      {thread.resolved != null && (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              thread.resolved ? "bg-[var(--acc-green)]" : "bg-[var(--acc-orange)]",
            )}
            aria-hidden
          />
          {thread.resolved ? "resolved" : "open"}
        </span>
      )}
    </span>
  );
}

function ThreadActions({
  thread,
  onViewThread,
  onSendThread,
}: {
  thread: CommentThread;
  onViewThread?: (thread: CommentThread) => void;
  onSendThread?: (thread: CommentThread) => void;
}): ReactElement | null {
  const url = thread.comments.find((comment) => comment.url)?.url ?? null;
  const host = threadExternalHost(thread);
  const [opening, setOpening] = useState(false);
  const open = useCallback(async (): Promise<void> => {
    if (!url) return;
    setOpening(true);
    await openExternalUrl(url, "Could not open this review thread.");
    setOpening(false);
  }, [url]);
  const canView = !!onViewThread && isThreadAnchored(thread) && thread.resolved !== true;
  const canSend = !!onSendThread && thread.resolved !== true;
  if (!url && !canView && !canSend) return null;
  return (
    // The hairline matches the separators between comments, so the actions read
    // as the end of the conversation rather than as a footer band. The inner
    // negative margins put the ghost buttons' icons on the text's left edge and
    // take back their padding below, so the card's bottom inset matches its top.
    <div className="mt-3 border-t border-border/60 pt-1.5">
      <div className="-mx-1.5 -mb-1.5 flex flex-wrap items-center gap-0.5">
        {canSend && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onSendThread(thread)}
          >
            <SendIcon className="size-3" aria-hidden />
            Send to agent
          </Button>
        )}
        {canView && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onViewThread(thread)}
          >
            <GitCompareArrowsIcon className="size-3" aria-hidden />
            View in diff
          </Button>
        )}
        {url && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground hover:text-foreground"
            disabled={opening}
            onClick={() => void open()}
          >
            {opening ? (
              <Loader2Icon className="size-3 animate-spin" aria-hidden />
            ) : (
              <ExternalLinkIcon className="size-3" aria-hidden />
            )}
            Reply on {host ?? "remote"}
          </Button>
        )}
      </div>
    </div>
  );
}
