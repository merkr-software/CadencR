import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";
import { Loader2Icon } from "lucide-react";
import { useListProjects, type Project } from "@/api/generated";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { UnifiedAgentsFilters } from "@/components/UnifiedAgentsFilters";
import { UnifiedAgentsGrid } from "@/components/UnifiedAgentsGrid";
import { useUnifiedAgentsFilters } from "@/components/UnifiedAgentsFilterState";
import {
  useUnifiedAgentsPerRowSetting,
  type UnifiedAgentsPerRowSetting,
} from "@/components/UnifiedAgentsPerRowSetting";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { useUnifiedAgentsFilterText } from "@/components/useUnifiedAgentsFilterText";
import { useUnifiedAgentsExcludePruning } from "@/components/useUnifiedAgentsExcludePruning";
import type { UnifiedAgentsFilterInputHandle } from "@/components/UnifiedAgentsDynamicFilter";
import { useUnifiedAgentPinControls } from "@/components/useUnifiedAgentPinControls";
import { useUnifiedAgentsData, type UnifiedAgentsData } from "@/components/UnifiedAgentsViewData";
import { useLiveWorkingCount } from "@/stores/session-status-selectors";

export function UnifiedAgentsView(): ReactElement {
  const [filters, setFilters] = useUnifiedAgentsFilters();
  const searchInputRef = useRef<UnifiedAgentsFilterInputHandle>(null);
  useGlobalShortcutById("agents-search", (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    searchInputRef.current?.focus();
  });
  const projectsQuery = useListProjects();
  const projects = projectsQuery.data ?? [];
  const data = useUnifiedAgentsData(filters);
  // Count working agents via the canonical live store, scoped to what's
  // currently visible in the grid. Selector returns a number, so unrelated
  // session-status mutations don't re-render the header.
  const visibleSessionIds = useMemo(
    () => data.agents.map((entry) => entry.session.sessionDbId),
    [data.agents],
  );
  const runningAgentsCount = useLiveWorkingCount(visibleSessionIds);
  const { filterText, commitFilterText, excludeAgent, setExcludedTitles } =
    useUnifiedAgentsFilterText(filters, setFilters, projects, searchInputRef);
  useUnifiedAgentsExcludePruning(data.pruneExcludedTitles, setExcludedTitles);
  const agentsPerRow = useUnifiedAgentsPerRowSetting();
  const columns = agentsPerRow.value;
  const { activeIndex, activeAgent, setActiveSessionId } = useActiveAgent(data.agents);
  const activePinControls = useUnifiedAgentPinControls(activeAgent, { showProgressToast: true });
  const { focusVersion, focusFirstMatchedAgent, handleActivate } = useUnifiedAgentsKeyboard({
    activeIndex,
    activePinControls,
    agents: data.agents,
    columns,
    excludeAgent,
    searchInputRef,
    setActiveSessionId,
  });
  const [searchEnterFocusRequest, setSearchEnterFocusRequest] = useState(0);
  const pendingSearchEnterFocusRef = useRef(false);
  const requestFirstMatchedAgentFocus = useCallback((): void => {
    pendingSearchEnterFocusRef.current = true;
    setSearchEnterFocusRequest((current) => current + 1);
  }, []);

  useEffect((): void => {
    if (!pendingSearchEnterFocusRef.current) return;
    pendingSearchEnterFocusRef.current = false;
    focusFirstMatchedAgent();
  }, [data.agents, focusFirstMatchedAgent, searchEnterFocusRequest]);

  return (
    <div className="flex h-full flex-col bg-background">
      <UnifiedAgentsHeader
        projects={projects}
        projectsError={projectsQuery.isError ? projectsQuery.error : null}
        agentsCount={data.agents.length}
        runningAgentsCount={runningAgentsCount}
        agentsPerRowSetting={agentsPerRow}
        filterText={filterText}
        searchInputRef={searchInputRef}
        isFetching={data.isFetching}
        onFilterTextChange={commitFilterText}
        onSearchEnter={requestFirstMatchedAgentFocus}
        onRefresh={data.refresh}
      />

      <UnifiedAgentsContent
        data={data}
        columns={columns}
        activeIndex={activeIndex}
        focusVersion={focusVersion}
        onActivate={handleActivate}
        onExcludeAgent={excludeAgent}
      />
    </div>
  );
}

interface ActiveAgentState {
  activeIndex: number;
  activeAgent: UnifiedAgentsData["agents"][number] | null;
  setActiveSessionId: (sessionId: number | null) => void;
}

function useActiveAgent(agents: UnifiedAgentsData["agents"]): ActiveAgentState {
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const activeIndex = resolveActiveIndex(agents, activeSessionId);
  const activeAgent = agents[activeIndex] ?? null;

  useEffect(() => {
    if (agents.length === 0) {
      setActiveSessionId(null);
      return;
    }
    if (
      activeSessionId !== null &&
      agents.some((entry) => entry.session.sessionDbId === activeSessionId)
    ) {
      return;
    }
    setActiveSessionId(agents[0].session.sessionDbId);
  }, [activeSessionId, agents]);

  return useMemo(
    () => ({ activeIndex, activeAgent, setActiveSessionId }),
    [activeIndex, activeAgent],
  );
}

interface UnifiedAgentsKeyboardArgs {
  agents: UnifiedAgentsData["agents"];
  columns: number;
  activeIndex: number;
  activePinControls: ReturnType<typeof useUnifiedAgentPinControls>;
  excludeAgent: (title: string) => void;
  searchInputRef: RefObject<UnifiedAgentsFilterInputHandle | null>;
  setActiveSessionId: (sessionId: number | null) => void;
}

interface UnifiedAgentsKeyboardState {
  focusVersion: number;
  focusFirstMatchedAgent: () => void;
  handleActivate: (index: number) => void;
}

function useUnifiedAgentsKeyboard({
  agents,
  columns,
  activeIndex,
  activePinControls,
  excludeAgent,
  searchInputRef,
  setActiveSessionId,
}: UnifiedAgentsKeyboardArgs): UnifiedAgentsKeyboardState {
  const [focusVersion, setFocusVersion] = useState(0);
  const focusFirstMatchedAgent = useCallback((): void => {
    if (agents.length === 0) return;
    searchInputRef.current?.blur();
    setActiveSessionId(agents[0].session.sessionDbId);
    setFocusVersion((current) => current + 1);
  }, [agents, searchInputRef, setActiveSessionId]);

  const moveFocus = useCallback(
    (direction: "left" | "right" | "up" | "down"): void => {
      if (agents.length === 0) return;
      const next = nextAgentIndex(activeIndex, direction, agents.length, columns);
      if (next === activeIndex) return;
      setActiveSessionId(agents[next]?.session.sessionDbId ?? null);
      setFocusVersion((current) => current + 1);
    },
    [activeIndex, agents, columns, setActiveSessionId],
  );

  // Window-level capture-phase listeners so navigation/pin work even when
  // focus is inside an xterm or CodeMirror (which stopPropagation native
  // keydown before React's delegated listeners see it).
  useGlobalShortcutById("agents-navigate-left", (e) => {
    consumeKeyEvent(e);
    moveFocus("left");
  });
  useGlobalShortcutById("agents-navigate-right", (e) => {
    consumeKeyEvent(e);
    moveFocus("right");
  });
  useGlobalShortcutById("agents-navigate-up", (e) => {
    consumeKeyEvent(e);
    moveFocus("up");
  });
  useGlobalShortcutById("agents-navigate-down", (e) => {
    consumeKeyEvent(e);
    moveFocus("down");
  });
  useGlobalShortcutById("agents-pin", (e) => {
    consumeKeyEvent(e);
    activePinControls.toggle();
  });
  useGlobalShortcutById("agents-hide", (e) => {
    consumeKeyEvent(e);
    const title = agents[activeIndex]?.feature.title;
    if (title) excludeAgent(title);
  });

  const handleActivate = useCallback(
    (index: number): void => setActiveSessionId(agents[index]?.session.sessionDbId ?? null),
    [agents, setActiveSessionId],
  );

  return useMemo(
    () => ({ focusVersion, focusFirstMatchedAgent, handleActivate }),
    [focusVersion, focusFirstMatchedAgent, handleActivate],
  );
}

function consumeKeyEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

interface UnifiedAgentsContentProps {
  data: UnifiedAgentsData;
  columns: number;
  activeIndex: number;
  focusVersion: number;
  onActivate: (index: number) => void;
  onExcludeAgent: (title: string) => void;
}

function UnifiedAgentsContent({
  data,
  columns,
  activeIndex,
  focusVersion,
  onActivate,
  onExcludeAgent,
}: UnifiedAgentsContentProps): ReactElement {
  if (data.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-destructive">
        {data.errorMessage}
      </div>
    );
  }
  if (data.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (data.agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No agents match this filter.
      </div>
    );
  }
  return (
    <UnifiedAgentsGrid
      agents={data.agents}
      columns={columns}
      activeIndex={activeIndex}
      focusVersion={focusVersion}
      onActivate={onActivate}
      onExcludeAgent={onExcludeAgent}
    />
  );
}

interface UnifiedAgentsHeaderProps {
  projects: Project[];
  projectsError: unknown;
  agentsCount: number;
  runningAgentsCount: number;
  agentsPerRowSetting: UnifiedAgentsPerRowSetting;
  filterText: string;
  searchInputRef: Ref<UnifiedAgentsFilterInputHandle>;
  isFetching: boolean;
  onFilterTextChange: (value: string) => void;
  onSearchEnter: () => void;
  onRefresh: () => void;
}

function UnifiedAgentsHeader({
  projects,
  projectsError,
  agentsCount,
  runningAgentsCount,
  agentsPerRowSetting,
  filterText,
  searchInputRef,
  isFetching,
  onFilterTextChange,
  onSearchEnter,
  onRefresh,
}: UnifiedAgentsHeaderProps): ReactElement {
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag shrink-0 border-b border-border/40 bg-background px-4 py-3">
      <div className="flex items-center gap-3">
        {sidebarCollapsed && <SidebarCollapsedChrome onExpand={() => setSidebarCollapsed(false)} />}
        <div className="min-w-0 flex-1">
          <UnifiedAgentsFilters
            filterText={filterText}
            projects={projects}
            agentsCount={agentsCount}
            runningAgentsCount={runningAgentsCount}
            agentsPerRowSetting={agentsPerRowSetting}
            searchInputRef={searchInputRef}
            isFetching={isFetching}
            onFilterTextChange={onFilterTextChange}
            onSearchEnter={onSearchEnter}
            onRefresh={onRefresh}
          />
        </div>
      </div>
      {projectsError ? (
        <p className="mt-2 px-1 text-xs text-destructive">
          {projectsError instanceof Error ? projectsError.message : "Failed to load projects."}
        </p>
      ) : null}
    </header>
  );
}

function nextAgentIndex(
  index: number,
  direction: "left" | "right" | "up" | "down",
  total: number,
  columns: number,
): number {
  if (total === 0) return 0;
  if (direction === "left") return Math.max(0, index - 1);
  if (direction === "right") return Math.min(total - 1, index + 1);
  if (direction === "up") return Math.max(0, index - columns);
  return Math.min(total - 1, index + columns);
}

function resolveActiveIndex(
  agents: UnifiedAgentsData["agents"],
  activeSessionId: number | null,
): number {
  if (agents.length === 0) return 0;
  if (activeSessionId === null) return 0;
  const index = agents.findIndex((entry) => entry.session.sessionDbId === activeSessionId);
  return index >= 0 ? index : 0;
}
