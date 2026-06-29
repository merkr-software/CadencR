import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { Circle } from "lucide-react";
import { HoverCard } from "radix-ui";
import { cn } from "@/lib/utils";

export interface ChangedFileEntry {
  file: string;
  status: string;
  oldFile?: string;
  additions: number;
  deletions: number;
  /**
   * True when the file has staged content (`git add`-ed). Backed by the
   * `is_staged` field on `ChangedFile` from `/api/git/changed-files`, threaded
   * through `useDiffData` and merged onto the parsed-diff entry list. Always
   * `false` in `branch` mode (no concept of staging when comparing commits).
   */
  is_staged?: boolean;
}

export interface CommitEntry {
  sha: string;
  shortSha: string;
  message: string;
  body: string;
  author: string;
  date: string;
  isPushed: boolean;
}

// Normalizes "2026-04-08 22:27:55 +0200" → ISO "2026-04-08T22:27:55+0200"
const GIT_DATE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/;

function parseGitDate(dateStr: string): number {
  return new Date(dateStr.replace(GIT_DATE_RE, "$1T$2$3")).getTime();
}

export function formatRelativeDate(dateStr: string): string {
  const then = parseGitDate(dateStr);
  if (Number.isNaN(then)) return dateStr;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function formatAbsoluteDate(dateStr: string): string {
  const then = parseGitDate(dateStr);
  if (Number.isNaN(then)) return dateStr;
  return new Date(then).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AutoScrollText({ text, className }: { text: string; className?: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const textEl = textRef.current;
    if (!wrapper || !textEl) return;

    const measure = () => {
      const overflow = textEl.scrollWidth - wrapper.clientWidth;
      if (overflow > 0) {
        textEl.style.setProperty("--scroll-distance", `-${overflow}px`);
        setOverflows(true);
      } else {
        textEl.style.removeProperty("--scroll-distance");
        setOverflows(false);
      }
    };

    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    measure();
    return () => ro.disconnect();
  }, [text]);

  return (
    <div
      ref={wrapperRef}
      className={cn("auto-scroll-wrapper min-w-0 flex-1 overflow-hidden", className)}
    >
      <span ref={textRef} className="auto-scroll-text" data-overflows={overflows}>
        {text}
      </span>
    </div>
  );
}

function CommitHoverContent({ commit }: { commit: CommitEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-1.5">
        <Circle
          className={cn(
            "mt-0.5 h-2.5 w-2.5 shrink-0",
            commit.isPushed
              ? "fill-[var(--numstat-add-fg)] text-[var(--numstat-add-fg)]"
              : "fill-[var(--acc-orange)] text-[var(--acc-orange)]",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          <span className="shrink-0 font-mono text-xs text-primary">{commit.shortSha}</span>
          <span className="text-xs font-medium text-foreground">{commit.message}</span>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
        <span>{commit.author}</span>
        <span>
          {formatRelativeDate(commit.date)} · {formatAbsoluteDate(commit.date)}
        </span>
      </div>
      {commit.body && (
        <p className="whitespace-pre-wrap border-t border-border pt-2 text-[10px] text-muted-foreground">
          {commit.body}
        </p>
      )}
    </div>
  );
}

export function CommitItemHoverCard({
  commit,
  children,
}: {
  commit: CommitEntry;
  children: ReactNode;
}) {
  return (
    <HoverCard.Root openDelay={400} closeDelay={100}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-slot="hover-card-content"
          className="z-50 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md
            data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <CommitHoverContent commit={commit} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
