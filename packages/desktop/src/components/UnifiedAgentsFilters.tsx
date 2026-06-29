import { memo, type ReactElement, type Ref } from "react";
import { ActivityIcon, BotIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { Project } from "@/api/generated";
import {
  UnifiedAgentsDynamicFilter,
  type UnifiedAgentsFilterInputHandle,
} from "@/components/UnifiedAgentsDynamicFilter";
import { UnifiedAgentsCounterPill } from "@/components/UnifiedAgentsCounterPill";
import { UnifiedAgentsNewFeatureButton } from "@/components/UnifiedAgentsNewFeatureButton";
import { UnifiedAgentsPerRowStepper } from "@/components/UnifiedAgentsPerRowStepper";
import type { UnifiedAgentsPerRowSetting } from "@/components/UnifiedAgentsPerRowSetting";
import { Button } from "@/components/ui/button";

export type UnifiedAgentsFilterMode = "recent" | "all";

interface UnifiedAgentsFiltersProps {
  filterText: string;
  projects: Project[];
  agentsCount: number;
  runningAgentsCount: number;
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
  agentsCount,
  runningAgentsCount,
  agentsPerRowSetting,
  searchInputRef,
  isFetching,
  onFilterTextChange,
  onSearchEnter,
  onRefresh,
}: UnifiedAgentsFiltersProps): ReactElement {
  return (
    <div className="grid grid-cols-[auto_minmax(260px,1fr)_auto_auto] items-center gap-3">
      <div className="justify-self-start">
        <UnifiedAgentsHeaderCounters
          agentsCount={agentsCount}
          runningAgentsCount={runningAgentsCount}
        />
      </div>
      <UnifiedAgentsDynamicFilter
        value={filterText}
        projects={projects}
        inputRef={searchInputRef}
        onValueChange={onFilterTextChange}
        onEnter={onSearchEnter}
      />
      <UnifiedAgentsPerRowStepper
        value={agentsPerRowSetting.value}
        isLoading={agentsPerRowSetting.isLoading}
        isSaving={agentsPerRowSetting.isSaving}
        onChange={agentsPerRowSetting.setValue}
      />
      <div className="flex items-center gap-2">
        <RefreshButton isFetching={isFetching} onRefresh={onRefresh} />
        <UnifiedAgentsNewFeatureButton projects={projects} />
      </div>
    </div>
  );
});

function RefreshButton({
  isFetching,
  onRefresh,
}: {
  isFetching: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-9 gap-2 rounded-lg border border-border/80 bg-background/90 px-3 text-xs text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] hover:bg-accent/70"
      onClick={onRefresh}
      disabled={isFetching}
    >
      {isFetching ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <RefreshCwIcon className="size-3.5" />
      )}
      Refresh
    </Button>
  );
}

function UnifiedAgentsHeaderCounters({
  agentsCount,
  runningAgentsCount,
}: {
  agentsCount: number;
  runningAgentsCount: number;
}): ReactElement {
  return (
    <div className="flex justify-start pt-0.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <UnifiedAgentsCounterPill
          icon={<BotIcon className="size-3" />}
          count={agentsCount}
          label="agents"
        />
        <UnifiedAgentsCounterPill
          icon={<ActivityIcon className="size-3 text-primary" />}
          count={runningAgentsCount}
          label="running"
        />
      </div>
    </div>
  );
}
