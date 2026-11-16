import type { ReactNode } from "react";
import { ArrowUp, Check } from "lucide-react";
import { HoverCard } from "radix-ui";

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

function CommitHoverContent({ commit }: { commit: CommitEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">{commit.message}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{commit.shortSha}</span>
      </div>
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        <span>{commit.author}</span>
        <span>
          {formatRelativeDate(commit.date)} · {formatAbsoluteDate(commit.date)}
        </span>
      </div>
      <PushState isPushed={commit.isPushed} />
      {commit.body && (
        <p className="whitespace-pre-wrap border-t border-border pt-2 text-[11px] text-muted-foreground">
          {commit.body}
        </p>
      )}
    </div>
  );
}

/** Local-only work, in the orange "local" tone shared by graph rows and their
 *  hover card. */
export function NotPushedLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--acc-orange)]">
      <ArrowUp className="size-3" aria-hidden />
      {children}
    </span>
  );
}

function PushState({ isPushed }: { isPushed: boolean }) {
  return isPushed ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Check className="size-3" aria-hidden />
      Pushed
    </span>
  ) : (
    <NotPushedLabel>Not pushed — only on your machine</NotPushedLabel>
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
