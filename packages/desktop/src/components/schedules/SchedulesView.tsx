import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { CalendarClock, Loader2Icon, PlusIcon } from "lucide-react";
import { useListProjects, type Schedule } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { fireAndForget, useSchedules } from "@/hooks/useSchedules";
import { nextRunAcross, scheduleStateLabel } from "@/lib/schedules/status";
import { formatRelative } from "@/lib/schedules/format";
import type { ScheduleActionTarget } from "@/lib/schedules/action-link";
import { cn } from "@/lib/utils";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { ScheduleGroups } from "./ScheduleGroups";
import { useActionPresetLink } from "./useActionPresetLink";
import type { ScheduleActionPreset } from "./useScheduleDraft";
import {
  filterByState,
  groupByProject,
  indexScheduleSearch,
  searchSchedules,
  stateCounts,
  type ScheduleFilterState,
} from "./schedule-filters";

const FILTERS: ScheduleFilterState[] = ["all", "upcoming", "failed", "paused", "completed"];

/**
 * The Schedules screen: every configured schedule across every project, in one
 * place.
 *
 * The organising idea is "what is about to happen": rows arrive soonest-first
 * from the backend and stay in that order inside their project group, so the
 * top of the page is always the next thing Cadencr will do on its own.
 */
export function SchedulesView({
  actionPreset = null,
}: {
  /** From a "Schedule this action" link: opens the editor on a new schedule
   *  for that action. */
  actionPreset?: ScheduleActionTarget | null;
}): ReactElement {
  const { i18n } = useUiTranslation();
  const locale = i18n.language;
  const projectsQuery = useListProjects();
  const { schedules, isLoading, isMutating, save, remove, setEnabled, runNow } = useSchedules();

  const [query, setQuery] = useState("");
  const [state, setState] = useState<ScheduleFilterState>("all");
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [initialAction, setInitialAction] = useState<ScheduleActionPreset | undefined>(undefined);

  const isSearching = query.trim().length > 0;
  const searchIndex = useMemo(
    () => (isSearching ? indexScheduleSearch(schedules, locale) : null),
    [isSearching, schedules, locale],
  );
  const searched = useMemo(
    () => (searchIndex ? searchSchedules(searchIndex, query, locale) : schedules),
    [searchIndex, schedules, query, locale],
  );
  const counts = useMemo(() => stateCounts(searched), [searched]);
  const groups = useMemo(() => groupByProject(filterByState(searched, state)), [searched, state]);
  const nextRun = useMemo(() => nextRunAcross(schedules), [schedules]);

  const openEditor = useCallback((schedule: Schedule | null): void => {
    setEditing(schedule);
    setInitialAction(undefined);
    setEditorOpen(true);
  }, []);
  const openActionEditor = useCallback((preset: ScheduleActionPreset): void => {
    setEditing(null);
    setInitialAction(preset);
    setEditorOpen(true);
  }, []);
  useActionPresetLink(actionPreset, openActionEditor);
  const toggle = useCallback(
    (schedule: Schedule) => fireAndForget(setEnabled(schedule.id, !schedule.enabled)),
    [setEnabled],
  );
  const run = useCallback((schedule: Schedule) => fireAndForget(runNow(schedule)), [runNow]);

  return (
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
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
          isFiltered={isSearching || state !== "all"}
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
        initialAction={initialAction}
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
  const { t, i18n } = useUiTranslation();
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 py-4">
      <div className="flex items-center gap-3">
        <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
        <CalendarClock className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold leading-tight">
            {t("schedules.page.title", "Schedules")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {summaryLine(t, total, nextRun, i18n.language)}
          </p>
        </div>
        {isLoading && (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden />
        )}
        <Button
          type="button"
          size="sm"
          className="h-9 gap-1.5 rounded-lg px-3 text-xs"
          onClick={onCreate}
        >
          <PlusIcon className="size-3.5" />
          {t("schedules.editor.createTitle", "New schedule")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("schedule.list.schedulesView.searchPlaceholder", "Search schedules…")}
          aria-label={t("schedule.list.schedulesView.searchSchedules", "Search schedules")}
          className="h-8 max-w-xs text-sm"
        />
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t("schedule.list.schedulesView.filterByStatus", "Filter by status")}
        >
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={state === filter}
              onClick={() => onStateChange(filter)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                state === filter
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {filter === "all"
                ? t("schedule.list.schedulesView.all", "All")
                : scheduleStateLabel(t, filter)}
              <span className="ml-1.5 tabular-nums opacity-70">
                {counts[filter].toLocaleString(i18n.language)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function summaryLine(t: UiTranslator, count: number, nextRun: Date | null, locale: string): string {
  if (count === 0)
    return t("schedule.list.schedulesView.nothingScheduledYet", "Nothing scheduled yet");
  return nextRun
    ? t("schedule.list.schedulesView.nextRun", "{{count, number}} schedules · next run {{when}}", {
        count,
        when: formatRelative(nextRun, locale),
        defaultValue_one: "{{count, number}} schedule · next run {{when}}",
      })
    : t("schedule.list.schedulesView.noneUpcoming", "{{count, number}} schedules · none upcoming", {
        count,
        defaultValue_one: "{{count, number}} schedule · none upcoming",
      });
}
