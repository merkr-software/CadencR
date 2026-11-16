import { memo, type ReactElement } from "react";
import { MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { StatusShape } from "@/components/StatusShape";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { parseUTCDateTime } from "@/lib/date-utils";
import { ATTENTION_LABEL, type AttentionState } from "@/lib/sidebar-attention";
import { formatSidebarFullTime, formatSidebarRelativeTime } from "@/lib/sidebar-time";
import { cn } from "@/lib/utils";
import type { PendingKind } from "@/types/agent";

/**
 * The leading mark on a card's title line: the sidebar's status shape, so a
 * conversation reads the same in both places. A waiting agent leads with the
 * request kind instead, in the amber the card's "needs you" text uses.
 */
export const AgentCardStatusGlyph = memo(function AgentCardStatusGlyph({
  state,
  kind,
}: {
  state: AttentionState;
  kind: PendingKind | null;
}): ReactElement {
  const WaitingIcon = kind === "permission" ? ShieldAlert : MessageCircleQuestion;
  return (
    <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center justify-center">
      {state === "waiting" ? (
        <WaitingIcon
          className="sidebar-pending-indicator size-3.5 text-(--acc-yellow)"
          strokeWidth={2.25}
        />
      ) : (
        <StatusShape state={state} />
      )}
    </span>
  );
});

const STATE_TEXT_CLASS: Record<Exclude<AttentionState, "idle">, string> = {
  waiting: "agent-card-state-pill text-(--acc-yellow)",
  failed: "agent-card-state-pill text-(--acc-red)",
  working: "text-(--color-blue-500)",
  unread: "text-(--acc-green)",
};

export function waitingLabel(kind: PendingKind | null): string {
  if (kind === "permission") return "Needs approval";
  if (kind === "question") return "Has a question";
  return ATTENTION_LABEL.waiting;
}

/**
 * The trailing word on a card's meta line: what the agent is doing when that
 * matters, else how long ago it last did something. The time ticks with the
 * shared minute clock, so it stays honest without a refetch.
 */
export const AgentCardStatusText = memo(function AgentCardStatusText({
  state,
  kind,
  lastActivityAt,
}: {
  state: AttentionState;
  kind: PendingKind | null;
  lastActivityAt?: string | null;
}): ReactElement | null {
  if (state === "idle") return <AgentCardActivityTime lastActivityAt={lastActivityAt} />;
  const label = state === "waiting" ? waitingLabel(kind) : ATTENTION_LABEL[state];
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-[11px] font-medium leading-none",
        STATE_TEXT_CLASS[state],
      )}
    >
      {label}
    </span>
  );
});

function AgentCardActivityTime({
  lastActivityAt,
}: {
  lastActivityAt?: string | null;
}): ReactElement | null {
  const now = useMinuteClock();
  if (!lastActivityAt) return null;
  const date = parseUTCDateTime(lastActivityAt);
  if (!Number.isFinite(date.getTime())) return null;
  const relative = formatSidebarRelativeTime(date, now);
  return (
    <time
      dateTime={date.toISOString()}
      title={`Last activity ${formatSidebarFullTime(date)}`}
      className="shrink-0 whitespace-nowrap font-mono text-[10.5px] leading-none text-muted-foreground tabular-nums"
    >
      {relative === "now" ? "just now" : `${relative} ago`}
    </time>
  );
}
