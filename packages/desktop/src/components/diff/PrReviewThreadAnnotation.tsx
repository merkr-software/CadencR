import { memo, useCallback, useEffect, useId, useMemo, useState, type ReactElement } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MessageSquareIcon,
} from "lucide-react";
import type { CommentThread } from "@/api/generated";
import { Markdown } from "@/components/Markdown";
import { PR_MARKDOWN_CLASS } from "@/components/pr-markdown";
import { relativeTime } from "@/components/FeaturePrViewParts";
import { ForgeAvatar } from "@/components/ForgeImage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { openExternalUrl } from "@/lib/open-external";
import { threadExternalHost, threadLocation } from "@/lib/pr-review-threads";
import { cn } from "@/lib/utils";

/**
 * A review thread the forge is hosting, rendered on the diff row it belongs to.
 *
 * These sit beside Cadencr's own draft comments, so they have to read as
 * *someone else's*: the author is always named, the accent is the review color
 * rather than the local-comment purple, and each thread keeps a link back to
 * the forge so the developer can reply where replying actually works.
 */
export const PrReviewThreadAnnotation = memo(function PrReviewThreadAnnotation({
  threads,
  activeThreadId,
  selectedThreadIds,
  onThreadSelectedChange,
}: {
  threads: CommentThread[];
  activeThreadId?: string | null;
  selectedThreadIds?: ReadonlySet<string>;
  onThreadSelectedChange?: (threadId: string, selected: boolean) => void;
}): ReactElement | null {
  if (threads.length === 0) return null;
  return (
    <div className="border-t border-[var(--editor-border)] bg-[var(--editor-bg)]">
      {threads.map((thread) => (
        <RemoteThread
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadId}
          selected={selectedThreadIds?.has(thread.id) ?? false}
          onSelectedChange={
            onThreadSelectedChange
              ? (selected) => onThreadSelectedChange(thread.id, selected)
              : undefined
          }
        />
      ))}
    </div>
  );
});

function RemoteThread({
  thread,
  active,
  selected,
  onSelectedChange,
}: {
  thread: CommentThread;
  active: boolean;
  selected: boolean;
  onSelectedChange?: (selected: boolean) => void;
}): ReactElement {
  const link = thread.comments.find((comment) => comment.url)?.url ?? undefined;
  const bodyLength = useMemo(
    () => thread.comments.reduce((total, comment) => total + comment.body_markdown.length, 0),
    [thread.comments],
  );
  const collapsible = thread.comments.length > 1 || bodyLength > 420;
  const [expanded, setExpanded] = useState(!collapsible);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  const visibleComments = expanded ? thread.comments : thread.comments.slice(0, 1);
  return (
    <section
      data-review-thread-id={thread.id}
      data-selected={selected || undefined}
      tabIndex={-1}
      aria-current={active ? "true" : undefined}
      className={cn(
        "mx-3 my-2 overflow-hidden rounded-lg border bg-[var(--editor-bg)] font-sans shadow-sm outline-none transition-[border-color,box-shadow]",
        active
          ? "border-primary ring-2 ring-primary/25"
          : selected
            ? "border-primary/70 ring-1 ring-primary/20"
            : "border-[var(--editor-blue)]/40 focus:border-primary focus:ring-2 focus:ring-primary/25",
      )}
    >
      <ReviewThreadHeader
        thread={thread}
        link={link}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
      <div className="divide-y divide-[var(--editor-border)]">
        {visibleComments.map((comment, index) => (
          <article key={`${comment.created_at}:${index}`} className="space-y-1.5 px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] !text-[var(--editor-comment)]">
              <ForgeAvatar user={comment.author} />
              <span className="truncate text-xs font-medium !text-[var(--editor-fg)]">
                {comment.author.display_name ?? comment.author.username}
              </span>
              <span className="shrink-0 tabular-nums">{relativeTime(comment.created_at)}</span>
            </div>
            <Markdown
              content={comment.body_markdown}
              cacheKey={`${thread.id}:${index}`}
              className={cn(
                PR_MARKDOWN_CLASS,
                // On the editor surface: its palette, not the app's, for the
                // body and for the shared prose's muted quote.
                "max-w-prose !text-[var(--editor-fg)]",
                "[&_blockquote]:border-[var(--editor-border)] [&_blockquote]:text-[var(--editor-comment)]",
                !expanded && bodyLength > 420 && "max-h-24 overflow-hidden",
              )}
            />
          </article>
        ))}
      </div>
      {collapsible && (
        <div className="flex justify-end border-t border-[var(--editor-border)] px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="!text-[var(--editor-comment)] hover:!text-[var(--editor-fg)]"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
            {expanded
              ? "Collapse thread"
              : `Show full thread · ${thread.comments.length} ${
                  thread.comments.length === 1 ? "message" : "messages"
                }`}
          </Button>
        </div>
      )}
    </section>
  );
}

function ReviewThreadHeader({
  thread,
  link,
  selected,
  onSelectedChange,
}: {
  thread: CommentThread;
  link: string | undefined;
  selected: boolean;
  onSelectedChange?: (selected: boolean) => void;
}): ReactElement {
  const selectionId = useId();
  return (
    <header className="flex items-center gap-2 border-b border-[var(--editor-border)] bg-[var(--editor-blue)]/10 px-3 py-1.5">
      {onSelectedChange && thread.resolved !== true && (
        <label
          htmlFor={selectionId}
          className="-my-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5"
          title="Send this thread to the agent"
        >
          <Checkbox
            id={selectionId}
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(checked === true)}
            aria-label={`Send ${threadLocation(thread) ?? "this general comment"} to the agent`}
            className="mr-0.5"
          />
          <MessageSquareIcon className="size-3 shrink-0 !text-[var(--editor-blue)]" aria-hidden />
          <span className="text-[11px] font-medium tracking-wide !text-[var(--editor-blue)]">
            Review thread
          </span>
          {thread.outdated && <OutdatedBadge />}
        </label>
      )}
      {(!onSelectedChange || thread.resolved === true) && (
        <>
          <MessageSquareIcon className="size-3 shrink-0 !text-[var(--editor-blue)]" aria-hidden />
          <span className="text-[11px] font-medium tracking-wide !text-[var(--editor-blue)]">
            Review thread
          </span>
          {thread.outdated && <OutdatedBadge />}
        </>
      )}
      <span className="ml-auto shrink-0">
        {link && <OpenOnForgeButton url={link} host={threadExternalHost(thread)} />}
      </span>
    </header>
  );
}

function OutdatedBadge(): ReactElement {
  return (
    <span
      className="rounded-full bg-[var(--editor-selection-bg)] px-2 py-0.5 text-[10px] !text-[var(--editor-comment)]"
      title="The diff moved since this comment was written"
    >
      outdated
    </span>
  );
}

function OpenOnForgeButton({ url, host }: { url: string; host: string | null }): ReactElement {
  const [opening, setOpening] = useState(false);
  const handleOpen = useCallback(async (): Promise<void> => {
    setOpening(true);
    await openExternalUrl(url, "Could not open the review comment.");
    setOpening(false);
  }, [url]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      // The annotation sits on the editor surface, not the app's card, so the
      // resting colors come from the editor palette; hover falls back to the
      // shared token, which reads correctly against both.
      className="!text-[var(--editor-comment)] hover:!text-[var(--editor-fg)]"
      disabled={opening}
      onClick={() => void handleOpen()}
      title="Open this review thread on the forge"
    >
      {opening ? (
        <Loader2Icon className="size-3 animate-spin" aria-hidden />
      ) : (
        <ExternalLinkIcon className="size-3" aria-hidden />
      )}
      Reply on {host ?? "remote"}
    </Button>
  );
}
