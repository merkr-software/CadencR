import { useCallback, useMemo, useState, type ReactElement } from "react";
import { CalendarClock, Loader2Icon, PlusIcon } from "lucide-react";
import { useListProjects, type Schedule } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { useSchedules } from "@/hooks/useSchedules";
import { nextRunAcross } from "@/lib/schedules/status";
import { formatRelative } from "@/lib/schedules/format";
import { cn } from "@/lib/utils";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { ScheduleGroups } from "./ScheduleGroups";
import {
  filterByState,
  groupByProject,
  searchSchedules,
  stateCounts,
  type ScheduleFilterState,
} from "./schedule-filters";

const FILTERS: { state: ScheduleFilterState; label: string }[] = [
  { state: "all", label: "All" },
  { state: "upcoming", label: "Upcoming" },
  { state: "failed", label: "Failed" },
  { state: "paused", label: "Paused" },
  { state: "completed", label: "Done" },
];

/**
 * The Schedules screen: every configured schedule across every project, in one
 * place.
 *
 * The organising idea is "what is about to happen": rows arrive soonest-first
 * from the backend and stay in that order inside their project group, so the
 * top of the page is always the next thing Cadencr will do on its own.
 */
export function SchedulesView(): ReactElement {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  const projectsQuery = useListProjects();
  const { schedules, isLoading, isMutating, save, remove, setEnabled, runNow } = useSchedules();

  const [query, setQuery] = useState("");
  const [state, setState] = useState<ScheduleFilterState>("all");
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const searched = useMemo(() => searchSchedules(schedules, query), [schedules, query]);
  const counts = useMemo(() => stateCounts(searched), [searched]);
  const groups = useMemo(() => groupByProject(filterByState(searched, state)), [searched, state]);
  const nextRun = useMemo(() => nextRunAcross(schedules), [schedules]);

  const openEditor = useCallback((schedule: Schedule | null): void => {
    setEditing(schedule);
    setEditorOpen(true);
  }, []);
  const toggle = useCallback(
    (schedule: Schedule) => void setEnabled(schedule.id, !schedule.enabled),
    [setEnabled],
  );
  const run = useCallback((schedule: Schedule) => void runNow(schedule.id), [runNow]);

  return (
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
      <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
      <SchedulesHeader
        total={schedules.length}
        nextRun={nextRun}
        isLoading={isLoading}
        query={query}
        onQueryChange={setQuery}
        state={state}
        onStateChange={setState}
        counts={counts}
        onCreate={() => openEditor(null)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ScheduleGroups
          groups={groups}
          isLoading={isLoading}
          hasAnySchedule={schedules.length > 0}
          isFiltered={query.trim().length > 0 || state !== "all"}
          busy={isMutating}
          onEdit={openEditor}
          onToggle={toggle}
          onRunNow={run}
          onCreate={() => openEditor(null)}
        />
      </div>

      <ScheduleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        schedule={editing}
        projects={projectsQuery.data ?? []}
        onSave={save}
        onDelete={remove}
      />
    </div>
  );
}

interface SchedulesHeaderProps {
  total: number;
  nextRun: Date | null;
  isLoading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  state: ScheduleFilterState;
  onStateChange: (state: ScheduleFilterState) => void;
  counts: Record<ScheduleFilterState, number>;
  onCreate: () => void;
}

function SchedulesHeader({
  total,
  nextRun,
  isLoading,
  query,
  onQueryChange,
  state,
  onStateChange,
  counts,
  onCreate,
}: SchedulesHeaderProps): ReactElement {
  return (
    <header className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 py-4">
      <div className="flex items-center gap-3">
        <CalendarClock className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold leading-tight">Schedules</h1>
          <p className="text-xs text-muted-foreground">{summaryLine(total, nextRun)}</p>
        </div>
        {isLoading && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        <Button
          type="button"
          size="sm"
          className="h-9 gap-1.5 rounded-lg px-3 text-xs"
          onClick={onCreate}
        >
          <PlusIcon className="size-3.5" />
          New schedule
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search schedules…"
          aria-label="Search schedules"
          className="h-8 max-w-xs text-sm"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
          {FILTERS.map((filter) => (
            <button
              key={filter.state}
              type="button"
              aria-pressed={state === filter.state}
              onClick={() => onStateChange(filter.state)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                state === filter.state
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {filter.label}
              <span className="ml-1.5 tabular-nums opacity-70">{counts[filter.state]}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function summaryLine(total: number, nextRun: Date | null): string {
  if (total === 0) return "Nothing scheduled yet";
  const count = `${total} schedule${total === 1 ? "" : "s"}`;
  return nextRun ? `${count} · next run ${formatRelative(nextRun)}` : `${count} · none upcoming`;
}
