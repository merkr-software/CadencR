import { memo, type ReactElement, type Ref } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { Project } from "@/api/generated";
import {
  UnifiedAgentsDynamicFilter,
  type UnifiedAgentsFilterInputHandle,
} from "@/components/UnifiedAgentsDynamicFilter";
import { UnifiedAgentsCounterPill } from "@/components/UnifiedAgentsCounterPill";
import { UnifiedAgentsNewFeatureButton } from "@/components/UnifiedAgentsNewFeatureButton";
import { UnifiedAgentsPerRowStepper } from "@/components/UnifiedAgentsPerRowStepper";
import type { UnifiedAgentsPerRowSetting } from "@/components/UnifiedAgentsPerRowSetting";
import type { UnifiedAgentsAttentionSummary } from "@/components/useUnifiedAgentsViewState";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";

export type UnifiedAgentsFilterMode = "recent" | "all";

interface UnifiedAgentsFiltersProps {
  filterText: string;
  projects: Project[];
  summary: UnifiedAgentsAttentionSummary;
  agentsPerRowSetting: UnifiedAgentsPerRowSetting;
  searchInputRef?: Ref<UnifiedAgentsFilterInputHandle>;
  isFetching: boolean;
  onFilterTextChange: (value: string) => void;
  onSearchEnter?: () => void;
  onRefresh: () => void;
}

export const UnifiedAgentsFilters = memo(function UnifiedAgentsFilters({
  filterText,
  projects,
  summary,
  agentsPerRowSetting,
  searchInputRef,
  isFetching,
  onFilterTextChange,
  onSearchEnter,
  onRefresh,
}: UnifiedAgentsFiltersProps): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <UnifiedAgentsSummary summary={summary} />
      <div className="min-w-[240px] flex-1">
        <UnifiedAgentsDynamicFilter
          value={filterText}
          projects={projects}
          inputRef={searchInputRef}
          onValueChange={onFilterTextChange}
          onEnter={onSearchEnter}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <UnifiedAgentsPerRowStepper
          value={agentsPerRowSetting.value}
          isLoading={agentsPerRowSetting.isLoading}
          isSaving={agentsPerRowSetting.isSaving}
          onChange={agentsPerRowSetting.setValue}
        />
        <RefreshButton isFetching={isFetching} onRefresh={onRefresh} />
        <UnifiedAgentsNewFeatureButton projects={projects} />
      </div>
    </div>
  );
});

/** The grid updates itself as agents change state; this forces a reload. */
function RefreshButton({
  isFetching,
  onRefresh,
}: {
  isFetching: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <ShortcutTooltip label={isFetching ? "Reloading agents…" : "Reload agents"} alignRight>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="titlebar-no-drag size-9 rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground"
        onClick={onRefresh}
        disabled={isFetching}
        aria-label="Reload agents"
        aria-busy={isFetching}
      >
        {isFetching ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-3.5" />
        )}
      </Button>
    </ShortcutTooltip>
  );
}

/**
 * How many agents the grid shows, then only the states that ask for a look.
 * Colors and shapes are the sidebar's, so "waiting" means the same amber
 * everywhere.
 */
function UnifiedAgentsSummary({
  summary,
}: {
  summary: UnifiedAgentsAttentionSummary;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-3 text-xs whitespace-nowrap text-muted-foreground">
      <span>
        <span className="font-semibold text-foreground tabular-nums">{summary.total}</span>{" "}
        {summary.total === 1 ? "agent" : "agents"}
      </span>
      <UnifiedAgentsCounterPill state="waiting" count={summary.waiting} />
      <UnifiedAgentsCounterPill state="failed" count={summary.failed} />
      <UnifiedAgentsCounterPill state="working" count={summary.working} />
      <UnifiedAgentsCounterPill state="unread" count={summary.unread} />
    </div>
  );
}
