import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { useListProjects, type UnifiedAgentEntry } from "@/api/generated";
import type { UnifiedAgentsFilterInputHandle } from "@/components/UnifiedAgentsDynamicFilter";
import {
  useUnifiedAgentsFilters,
  type PersistedUnifiedAgentsFilters,
} from "@/components/UnifiedAgentsFilterState";
import { useUnifiedAgentsPerRowSetting } from "@/components/UnifiedAgentsPerRowSetting";
import { useUnifiedAgentsData, type UnifiedAgentsData } from "@/components/UnifiedAgentsViewData";
import { useStableAgentOrder } from "@/components/useStableAgentOrder";
import { useUnifiedAgentPinControls } from "@/components/useUnifiedAgentPinControls";
import { useUnifiedAgentsExcludePruning } from "@/components/useUnifiedAgentsExcludePruning";
import { useUnifiedAgentsFilterText } from "@/components/useUnifiedAgentsFilterText";
import {
  defaultAgentRowHeight,
  effectiveAgentColumns,
} from "@/components/unified-agents-grid-geometry";
import { useActiveAgent, useUnifiedAgentsKeyboard } from "@/components/useUnifiedAgentsKeyboard";
import { useElementSize } from "@/hooks/useElementSize";
import { useSessionStatusStore } from "@/stores/session-status-store";

/** How many shown agents are in each state that asks for a look. */
export interface UnifiedAgentsAttentionSummary {
  total: number;
  waiting: number;
  failed: number;
  working: number;
  unread: number;
}

/**
 * Everything the unified agents page derives from its stores: the filter,
 * the agents in a stable order, the fitted grid geometry, and the keyboard
 * model. The view itself only lays these out.
 */
export function useUnifiedAgentsViewState(gridAreaRef: RefObject<HTMLElement | null>) {
  const [filters, setFilters] = useUnifiedAgentsFilters();
  const searchInputRef = useRef<UnifiedAgentsFilterInputHandle>(null);
  const projectsQuery = useListProjects();
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const data = useUnifiedAgentsData(filters);
  const order = useStableOrder(data, filters);
  const filterText = useUnifiedAgentsFilterText(filters, setFilters, projects, searchInputRef);
  useUnifiedAgentsExcludePruning(data.pruneExcludedTitles, filterText.setExcludedTitles);
  const hideAgent = useHideAgentWithUndo(filterText);
  const agentsPerRow = useUnifiedAgentsPerRowSetting();
  const viewport = useElementSize(gridAreaRef);
  const columns = effectiveAgentColumns(
    viewport?.width ?? null,
    agentsPerRow.value,
    order.agents.length,
  );
  const { activeIndex, activeAgent, setActiveSessionId } = useActiveAgent(order.agents);
  const activePinControls = useUnifiedAgentPinControls(activeAgent, { showProgressToast: true });
  const keyboard = useUnifiedAgentsKeyboard({
    activeIndex,
    activePinControls,
    agents: order.agents,
    columns,
    hideAgent,
    searchInputRef,
    setActiveSessionId,
  });
  const requestFirstMatchedAgentFocus = useSearchEnterFocus(
    order.agents,
    keyboard.focusFirstMatchedAgent,
  );
  const summary = useAttentionSummary(order.agents, data.attentionByFeature);

  return {
    filters,
    projects,
    projectsError: projectsQuery.isError ? projectsQuery.error : null,
    data,
    agents: order.agents,
    pendingChanges: order.pendingChanges,
    resort: order.resort,
    summary,
    filterText,
    hideAgent,
    searchInputRef,
    agentsPerRow,
    columns,
    defaultRowHeight: defaultAgentRowHeight(viewport?.height ?? null),
    activeIndex,
    focusVersion: keyboard.focusVersion,
    handleActivate: setActiveSessionId,
    requestFirstMatchedAgentFocus,
  };
}

function useStableOrder(data: UnifiedAgentsData, filters: PersistedUnifiedAgentsFilters) {
  const { attentionByFeature } = data;
  // Reading a reply (unread → idle) is the user's own doing: it may drift the
  // order, but it must not ask them to re-sort.
  const signatureOf = useCallback(
    (entry: UnifiedAgentEntry): string => {
      const state = attentionByFeature.get(entry.feature.id) ?? "idle";
      const moved = state === "unread" ? "idle" : state;
      return `${moved}|${entry.is_pinned}|${entry.last_activity_at ?? ""}`;
    },
    [attentionByFeature],
  );
  // Hiding an agent only removes its card, so it must not re-take the order.
  const resetKey = JSON.stringify([
    filters.mode,
    filters.freshMinutes,
    filters.projectIds,
    filters.pinnedOnly,
    filters.query,
    filters.sortOrder,
  ]);
  // The order is taken once the live statuses are in too: freezing on the
  // REST list alone would lock in an order that ignores who is waiting.
  const hasLiveStatus = useSessionStatusStore((state) => state.hasSnapshot);
  return useStableAgentOrder(data.agents, signatureOf, resetKey, !data.isLoading && hasLiveStatus);
}

/** Hide a card from the view, with an undo toast: hiding is one click away
 *  from a mistake and otherwise only reversible by editing the filter. */
function useHideAgentWithUndo(
  filterText: ReturnType<typeof useUnifiedAgentsFilterText>,
): (title: string) => void {
  const { excludeAgent, includeAgent } = filterText;
  // The toast outlives this render; its Undo must see the filter as it is then.
  const includeRef = useRef(includeAgent);
  useEffect(() => {
    includeRef.current = includeAgent;
  }, [includeAgent]);
  return useCallback(
    (title: string): void => {
      excludeAgent(title);
      toast(`Hidden “${title}”`, {
        id: `unified-agents-hide-${title.toLowerCase()}`,
        action: { label: "Undo", onClick: () => includeRef.current(title) },
      });
    },
    [excludeAgent],
  );
}

/** Enter in the search box focuses the first match once the filter applied. */
function useSearchEnterFocus(
  agents: UnifiedAgentEntry[],
  focusFirstMatchedAgent: () => void,
): () => void {
  const [request, setRequest] = useState(0);
  const pendingRef = useRef(false);
  useEffect((): void => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    focusFirstMatchedAgent();
  }, [agents, focusFirstMatchedAgent, request]);
  return useCallback((): void => {
    pendingRef.current = true;
    setRequest((current) => current + 1);
  }, []);
}

function useAttentionSummary(
  agents: UnifiedAgentEntry[],
  attentionByFeature: UnifiedAgentsData["attentionByFeature"],
): UnifiedAgentsAttentionSummary {
  return useMemo(() => {
    const summary = { total: agents.length, waiting: 0, failed: 0, working: 0, unread: 0 };
    for (const entry of agents) {
      const state = attentionByFeature.get(entry.feature.id);
      if (state && state !== "idle") summary[state] += 1;
    }
    return summary;
  }, [agents, attentionByFeature]);
}
