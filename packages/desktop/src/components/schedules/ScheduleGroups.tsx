import { memo, type ReactElement } from "react";
import { CalendarClock, SearchX } from "lucide-react";
import type { Schedule } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduleRow } from "./ScheduleRow";
import type { ScheduleGroup } from "./schedule-filters";

export interface ScheduleGroupsProps {
  groups: ScheduleGroup[];
  isLoading: boolean;
  /** Whether any schedule exists at all, to tell "none yet" from "none match". */
  hasAnySchedule: boolean;
  isFiltered: boolean;
  busy: boolean;
  onEdit: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onRunNow: (schedule: Schedule) => void;
  onCreate: () => void;
}

/** Project-grouped schedule list, with the three states a list can be in:
 *  loading, genuinely empty, and empty-because-filtered. */
export const ScheduleGroups = memo(function ScheduleGroups({
  groups,
  isLoading,
  hasAnySchedule,
  isFiltered,
  busy,
  onEdit,
  onToggle,
  onRunNow,
  onCreate,
}: ScheduleGroupsProps): ReactElement {
  if (isLoading && !hasAnySchedule) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading schedules">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!groups.length) {
    return isFiltered ? (
      <EmptyState
        icon={<SearchX className="size-5" />}
        title="No schedules match"
        body="Try a different search or filter."
      />
    ) : (
      <EmptyState
        icon={<CalendarClock className="size-5" />}
        title="No schedules yet"
        body="Schedule a prompt to run once at a set time, or on a repeating cadence — into an existing conversation or a brand-new one."
        action={
          <Button type="button" size="sm" onClick={onCreate}>
            Create your first schedule
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h2 className="flex items-baseline gap-2 px-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
            <span className="font-normal tabular-nums opacity-70">{group.schedules.length}</span>
          </h2>
          <ul className="flex flex-col gap-1.5">
            {group.schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                busy={busy}
                onEdit={onEdit}
                onToggle={onToggle}
                onRunNow={onRunNow}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
});

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactElement;
  title: string;
  body: string;
  action?: ReactElement;
}): ReactElement {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-16 text-center">
      <span className="text-muted-foreground">{icon}</span>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
