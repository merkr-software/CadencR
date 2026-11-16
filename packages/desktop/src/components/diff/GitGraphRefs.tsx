import { memo, type ReactElement } from "react";
import { CloudIcon, GitBranchIcon, TagIcon, type LucideIcon } from "lucide-react";
import type { CommitRef, CommitRefKind } from "@/api/generated";
import { cn } from "@/lib/utils";

/** Past this many labels a row keeps its message readable and folds the rest. */
const MAX_VISIBLE_REFS = 3;

/** `order` puts the checked-out branch first: it is the "you are here" mark
 *  the eye looks for. */
const KIND_STYLE: Record<CommitRefKind, { icon: LucideIcon; order: number; className: string }> = {
  head: {
    icon: GitBranchIcon,
    order: 0,
    className: "bg-primary/12 font-medium text-primary ring-primary/35",
  },
  local: {
    icon: GitBranchIcon,
    order: 1,
    className: "bg-secondary text-secondary-foreground ring-border",
  },
  // Outlined, never filled: a remote ref is where the branch was last pushed
  // to, not something to work on — it reads as a marker, not a branch.
  remote: { icon: CloudIcon, order: 2, className: "text-muted-foreground ring-border" },
  tag: { icon: TagIcon, order: 3, className: "bg-muted text-muted-foreground ring-transparent" },
};

function sortRefs(refs: readonly CommitRef[]): CommitRef[] {
  return [...refs].sort((a, b) => KIND_STYLE[a.kind].order - KIND_STYLE[b.kind].order);
}

/** The refs decorating one commit, typed so local, remote and tags read apart. */
export const CommitRefChips = memo(function CommitRefChips({
  refs,
}: {
  refs: readonly CommitRef[];
}): ReactElement | null {
  if (refs.length === 0) return null;
  const sorted = sortRefs(refs);
  const visible = sorted.slice(0, MAX_VISIBLE_REFS);
  const hidden = sorted.slice(MAX_VISIBLE_REFS);
  return (
    // Up to 45% of the line: the message truncates first, and a ref name stays
    // whole enough to recognize instead of collapsing to "feature/…".
    <span className="flex max-w-[45%] shrink-0 items-center gap-1 overflow-hidden">
      {visible.map((ref) => (
        <CommitRefChip key={`${ref.kind}:${ref.name}`} commitRef={ref} />
      ))}
      {hidden.length > 0 && (
        <span
          className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
          title={hidden.map((ref) => ref.name).join(", ")}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
});

function CommitRefChip({ commitRef }: { commitRef: CommitRef }): ReactElement {
  const style = KIND_STYLE[commitRef.kind];
  const Icon = style.icon;
  return (
    <span
      data-ref-kind={commitRef.kind}
      className={cn(
        "inline-flex h-[18px] min-w-0 max-w-48 shrink items-center gap-1 rounded px-1.5 font-mono text-[10.5px] leading-none ring-1 ring-inset",
        style.className,
      )}
    >
      <Icon className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{commitRef.name}</span>
    </span>
  );
}
