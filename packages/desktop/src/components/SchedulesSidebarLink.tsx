import { memo, useMemo, type ReactElement } from "react";
import { CalendarClock } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useScheduleList } from "@/hooks/useSchedules";
import { formatRelative } from "@/lib/schedules/format";
import { isActive, nextRunAcross } from "@/lib/schedules/status";
import { cn } from "@/lib/utils";

/**
 * Sidebar entry for the Schedules screen, mirroring the Agents link above it.
 *
 * The badge counts *armed* schedules — enabled, not finished, with a run
 * pending — because that is the number that answers "what will Cadencr do on
 * its own?". Paused and completed rules still exist on the page but must not
 * inflate a count the user reads as a promise.
 */
export const SchedulesSidebarLink = memo(function SchedulesSidebarLink(): ReactElement {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === "/schedules";
  // Shares the schedules query cache with the page, so opening Schedules costs
  // no extra request and the badge updates from the same poll. A badge only
  // reads, so it takes the query without the mutation half.
  const { schedules } = useScheduleList();
  const { count, nextRun } = useMemo(
    () => ({
      count: schedules.filter(isActive).length,
      nextRun: nextRunAcross(schedules),
    }),
    [schedules],
  );

  return (
    <ShortcutTooltip label="Open schedules" keys={["cmd", "shift", "Y"]} className="w-full">
      <Link
        to="/schedules"
        data-nav-item
        data-nav-type="schedules"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
          "focus-visible:bg-accent focus-visible:outline-none",
          active
            ? "bg-accent/50 text-accent-foreground font-medium"
            : "text-foreground hover:bg-accent/50",
        )}
      >
        <CalendarClock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Schedules</span>
        <ScheduledCountIndicator count={count} nextRun={nextRun} />
      </Link>
    </ShortcutTooltip>
  );
});

function ScheduledCountIndicator({
  count,
  nextRun,
}: {
  count: number;
  nextRun: Date | null;
}): ReactElement {
  const armed = count > 0;
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
      title={
        armed
          ? `${count} schedule${count === 1 ? "" : "s"} armed${nextRun ? ` · next ${formatRelative(nextRun)}` : ""}`
          : "No schedules armed"
      }
    >
      <span
        className={cn("size-1.5 rounded-full", armed ? "bg-primary" : "bg-muted-foreground/40")}
      />
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
