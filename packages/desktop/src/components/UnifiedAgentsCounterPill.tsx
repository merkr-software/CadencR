import { UiTrans } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import type { AttentionState } from "@/lib/sidebar-attention";
import { cn } from "@/lib/utils";

type CountedState = Exclude<AttentionState, "idle">;

const DOT_CLASS: Record<CountedState, string> = {
  waiting: "bg-(--acc-yellow)",
  failed: "bg-(--acc-red)",
  working: "sidebar-status-dot-working bg-blue-500",
  unread: "bg-(--acc-green)",
};

interface UnifiedAgentsCounterPillProps {
  state: CountedState;
  count: number;
}

/** One state's count in the header summary; absent when nothing is in it. */
export function UnifiedAgentsCounterPill({
  state,
  count,
}: UnifiedAgentsCounterPillProps): ReactElement | null {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT_CLASS[state])} />
      <span>
        <UiTrans
          {...COUNTER_COPY[state]}
          count={count}
          components={{ value: <span className="font-semibold text-foreground tabular-nums" /> }}
        />
      </span>
    </span>
  );
}

const COUNTER_COPY = {
  waiting: {
    i18nKey: "agents.overview.summary.waiting",
    defaults: "<value>{{count, number}}</value> waiting",
  },
  failed: {
    i18nKey: "agents.overview.summary.failed",
    defaults: "<value>{{count, number}}</value> failed",
  },
  working: {
    i18nKey: "agents.overview.summary.working",
    defaults: "<value>{{count, number}}</value> working",
  },
  unread: {
    i18nKey: "agents.overview.summary.unread",
    defaults: "<value>{{count, number}}</value> unread",
  },
} satisfies Record<CountedState, { i18nKey: string; defaults: string }>;
