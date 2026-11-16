import {
  AlertCircleIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  GitPullRequestIcon,
  Loader2Icon,
} from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { type PrStatusSnapshot } from "@/api/generated";
import { Markdown } from "@/components/Markdown";
import { PR_MARKDOWN_CLASS } from "@/components/pr-markdown";
import { EYEBROW_TEXT_CLASS } from "@/components/SidebarBlock";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

export function PrViewLoading(): ReactElement {
  return (
    <div className="space-y-4 p-4" role="status" aria-label="Loading pull request">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-3.5 w-48 max-w-full" />
        </div>
        <Skeleton className="h-8 w-20 shrink-0 rounded-md" />
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-28 rounded-md" />
        <Skeleton className="h-6 w-24 rounded-md" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
      <span className="sr-only">
        <Loader2Icon className="inline size-3 animate-spin" aria-hidden /> Loading pull request…
      </span>
    </div>
  );
}

export function PrViewError({
  message,
  compact = false,
}: {
  message: string;
  compact?: boolean;
}): ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 border border-destructive/40 bg-destructive/10 text-sm text-destructive",
        compact ? "rounded-md px-3 py-2" : "m-4 rounded-md p-3",
      )}
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 break-words leading-snug">{message}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  detail,
  action,
  icon,
}: {
  title: string;
  description: string;
  /**
   * Verbatim explanation from a forge, shown under the description. Clamped
   * because it is not always a sentence — a rejected request can come back as a
   * page of JSON, which would otherwise read as the card's own copy.
   */
  detail?: string | null;
  action?: ReactElement;
  icon?: ReactElement;
}): ReactElement {
  return (
    <div className="grid h-full place-items-center px-6 py-10 text-center">
      <div className="max-w-[18rem] space-y-3">
        <div className="mx-auto grid size-10 place-items-center rounded-md border border-border bg-card text-muted-foreground">
          {icon ?? <CircleDashedIcon className="size-5" aria-hidden />}
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-balance text-foreground">{title}</h2>
          <p className="text-[12.5px] leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
          {detail ? (
            <p className="line-clamp-3 text-[11.5px] leading-relaxed text-pretty text-muted-foreground/70">
              {detail}
            </p>
          ) : null}
        </div>
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

export function PrEmptyIcon(): ReactElement {
  return <GitPullRequestIcon className="size-5" aria-hidden />;
}

/**
 * The proposal's own text, folded away.
 *
 * You wrote this, or you read it once — either way it is the least urgent thing
 * on the pane, and full-height it pushed the first review thread below the fold
 * on every single visit. Folded, its first line still carries enough to
 * recognise, and one click gets the rest.
 */
export function PrDescription({ status }: { status: PrStatusSnapshot }): ReactElement {
  const pr = status.pr!;
  const [open, setOpen] = useState(false);
  // The header re-renders on every pick and every keystroke; splitting a body
  // that can run to tens of kilobytes for a one-line preview does not need to
  // happen again each time.
  const preview = useMemo(() => descriptionPreview(pr.body_markdown), [pr.body_markdown]);
  if (!pr.body_markdown.trim()) {
    return <p className="text-[12.5px] text-muted-foreground">No description provided.</p>;
  }
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-1 text-left",
          "transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className={cn("shrink-0", EYEBROW_TEXT_CLASS)}>Description</span>
        {!open && (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{preview}</span>
        )}
      </button>
      <CollapsibleSection open={open}>
        <Markdown
          content={pr.body_markdown}
          cacheKey={`${pr.url}:description`}
          className={cn(
            PR_MARKDOWN_CLASS,
            // Same inset as a review thread card, so the two surfaces line up.
            "mt-1.5 max-w-none overflow-x-auto rounded-lg border border-border bg-card px-3.5 py-3",
          )}
        />
      </CollapsibleSection>
    </section>
  );
}

/**
 * First line of actual prose. Headings are skipped rather than unwrapped: a
 * preview reading "Summary" tells you nothing you did not already know, and
 * almost every template starts with one.
 */
function descriptionPreview(markdown: string): string {
  for (const rawLine of markdown.split("\n")) {
    if (/^\s*#{1,6}\s/.test(rawLine)) continue;
    const line = rawLine
      .replace(/^\s*[>*-]+\s*/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line) return line;
  }
  return "";
}
