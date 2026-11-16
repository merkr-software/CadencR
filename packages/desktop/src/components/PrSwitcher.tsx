/**
 * Which of the conversation's pull requests the PR pane shows: one tab per
 * branch, the current branch first, every tab at the same weight. Opening a
 * proposal on its host is the band's `Open` button; picking one here swaps the
 * pane to it, threads included.
 */
import { memo, useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { GitBranchIcon } from "lucide-react";

import { prStatusLabel, PrToneDot } from "@/components/PrStatusIndicators";
import { branchTail, type ThreadPr } from "@/lib/thread-prs";
import { cn } from "@/lib/utils";

export interface PrSwitcherTab {
  /** `null` for the current branch's tab. */
  prNumber: number | null;
  branch: string;
  /** Absent for a current branch that has no proposal yet. */
  pr?: ThreadPr;
}

export const PrSwitcher = memo(function PrSwitcher({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly PrSwitcherTab[];
  /** The shown tab's `prNumber`. */
  selected: number | null;
  onSelect: (prNumber: number | null) => void;
}): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.prNumber === selected);
      const next = tabs[(index + step + tabs.length) % tabs.length];
      if (!next) return;
      onSelect(next.prNumber);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-pr-switcher-tab="${next.prNumber ?? "current"}"]`)
        ?.focus();
    },
    [onSelect, selected, tabs],
  );
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Pull requests of this conversation"
      onKeyDown={onKeyDown}
      // The fade says "more this way" on a phone, where the last tabs sit past
      // the edge; `pr-6` and `scroll-pr-6` let the last one scroll clear of it. Wide, it lands on
      // empty strip and changes nothing.
      className={cn(
        "flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card/40 pl-2.5 pr-6 scroll-pr-6",
        "[scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
      )}
    >
      {tabs.map((tab) => (
        <SwitcherTab
          key={tab.prNumber ?? "current"}
          tab={tab}
          active={tab.prNumber === selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
});

function SwitcherTab({
  tab,
  active,
  onSelect,
}: {
  tab: PrSwitcherTab;
  active: boolean;
  onSelect: (prNumber: number | null) => void;
}): ReactElement {
  const label = tab.pr ? prStatusLabel(tab.pr) : "No pull request yet";
  const isCurrent = tab.prNumber === null;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-pr-switcher-tab={tab.prNumber ?? "current"}
      onClick={() => onSelect(tab.prNumber)}
      title={`${tab.branch}${isCurrent ? " (current branch)" : ""}: ${label}`}
      className={cn(
        "relative inline-flex h-9 min-w-0 max-w-64 shrink-0 items-center gap-1.5 px-1.5 text-[12px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors",
        active
          ? "text-foreground after:bg-foreground"
          : "text-muted-foreground after:bg-transparent hover:text-foreground",
      )}
    >
      {isCurrent && (
        <GitBranchIcon className="size-3 shrink-0" aria-label="Current branch" role="img" />
      )}
      {tab.pr ? (
        <>
          <PrToneDot health={tab.pr} />
          <span className="shrink-0 font-mono font-medium tabular-nums">#{tab.pr.pr.number}</span>
        </>
      ) : null}
      <span className={cn("min-w-0 truncate font-mono", !active && "text-muted-foreground")}>
        {branchTail(tab.branch)}
      </span>
    </button>
  );
}
