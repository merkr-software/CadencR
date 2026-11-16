import { useCallback, useRef, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import {
  UnifiedAgentsLoadError,
  UnifiedAgentsNoAgents,
  UnifiedAgentsNoMatches,
} from "@/components/UnifiedAgentsEmptyState";
import { UnifiedAgentsFilters } from "@/components/UnifiedAgentsFilters";
import { serializeUnifiedAgentsFilterText } from "@/components/UnifiedAgentsFilterLanguage";
import { UnifiedAgentsGrid } from "@/components/UnifiedAgentsGrid";
import { UnifiedAgentsResortPill } from "@/components/UnifiedAgentsResortPill";
import { useUnifiedAgentsViewState } from "@/components/useUnifiedAgentsViewState";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";

type ViewState = ReturnType<typeof useUnifiedAgentsViewState>;

export function UnifiedAgentsView(): ReactElement {
  const gridAreaRef = useRef<HTMLDivElement>(null);
  const view = useUnifiedAgentsViewState(gridAreaRef);
  return (
    // Same chassis hooks as the full-page feature view: CadencR themes paint
    // the outer rail as `--sidebar` and lift the grid into a raised page card
    // under a header that merges into the sidebar band.
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
      <UnifiedAgentsHeader view={view} />
      <div
        ref={gridAreaRef}
        data-feature-layout-shell
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <UnifiedAgentsResortPill changes={view.pendingChanges} onResort={view.resort} />
        <UnifiedAgentsContent view={view} />
      </div>
    </div>
  );
}

function UnifiedAgentsContent({ view }: { view: ViewState }): ReactElement {
  const { data, filters, projects, filterText } = view;
  const { replaceFilterText } = filterText;
  const clearFilter = useCallback((): void => replaceFilterText(""), [replaceFilterText]);
  const showAll = useCallback(
    (): void =>
      replaceFilterText(serializeUnifiedAgentsFilterText({ ...filters, mode: "all" }, projects)),
    [filters, projects, replaceFilterText],
  );
  if (data.isError) {
    return <UnifiedAgentsLoadError message={data.errorMessage} onRetry={data.refresh} />;
  }
  if (data.isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading agents"
        className="flex flex-1 items-center justify-center"
      >
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (view.agents.length === 0) {
    return filterText.filterText.trim().length === 0 ? (
      <UnifiedAgentsNoAgents />
    ) : (
      <UnifiedAgentsNoMatches
        canShowAll={filters.mode === "recent"}
        onClearFilter={clearFilter}
        onShowAll={showAll}
      />
    );
  }
  return (
    <UnifiedAgentsGrid
      agents={view.agents}
      columns={view.columns}
      defaultRowHeight={view.defaultRowHeight}
      activeIndex={view.activeIndex}
      focusVersion={view.focusVersion}
      onActivate={view.handleActivate}
      onExcludeAgent={view.hideAgent}
    />
  );
}

function UnifiedAgentsHeader({ view }: { view: ViewState }): ReactElement {
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed();
  return (
    <header
      data-feature-header
      data-unified-agents-header
      data-mac-controls={HAS_MAC_WINDOW_CONTROLS ? "true" : undefined}
      data-window-control-safe
      className="titlebar-drag flex shrink-0 items-center gap-3 border-b border-border/40 bg-background px-4 py-3 md:px-6"
    >
      <SidebarCollapsedChrome
        visible={sidebarCollapsed}
        onExpand={() => setSidebarCollapsed(false)}
      />
      <h1 className="sr-only">Agents</h1>
      <div className="min-w-0 flex-1">
        <UnifiedAgentsFilters
          filterText={view.filterText.filterText}
          projects={view.projects}
          summary={view.summary}
          agentsPerRowSetting={view.agentsPerRow}
          searchInputRef={view.searchInputRef}
          isFetching={view.data.isFetching}
          onFilterTextChange={view.filterText.commitFilterText}
          onSearchEnter={view.requestFirstMatchedAgentFocus}
          onRefresh={view.data.refresh}
        />
        {view.projectsError ? (
          <p className="mt-2 px-1 text-xs text-destructive">
            {apiErrorMessage(view.projectsError, "Failed to load projects.")}
          </p>
        ) : null}
      </div>
    </header>
  );
}
