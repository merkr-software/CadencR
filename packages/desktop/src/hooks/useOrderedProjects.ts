import { useCallback, useEffect, useMemo } from "react";
import {
  getListFeaturesQueryKey,
  useListActiveFeatures,
  useListProjects,
  type Feature,
  type Project,
} from "@/api/generated";
import { applyOrder } from "@/lib/frozen-order";
import { queryClient } from "@/lib/queryClient";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { lastActivityOf, NAME_COLLATOR } from "@/lib/sidebar-lens";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarProjectOrderStore } from "@/stores/sidebar-project-order-store";

/**
 * Projects by their newest active conversation, as it happens; projects with
 * none keep the backend's order after them.
 */
function orderByLiveActivity<T extends { id: number }>(
  projects: readonly T[],
  features: readonly Feature[],
): T[] {
  const latest = new Map<number, string>();
  for (const feature of features) {
    const at = lastActivityOf(feature);
    if ((latest.get(feature.project_id) ?? "") < at) latest.set(feature.project_id, at);
  }
  return [...projects].sort((a, b) => {
    const left = latest.get(a.id) ?? "";
    const right = latest.get(b.id) ?? "";
    return left < right ? 1 : left > right ? -1 : 0;
  });
}

/**
 * Projects per the "Sort projects" option: the frozen `order`, live (from the
 * active conversations) or by name.
 */
export function orderProjects<T extends { id: number; name: string }>(
  projects: readonly T[],
  sort: SidebarConfig["projectSort"],
  order: readonly number[] | null,
  activeFeatures: readonly Feature[],
): T[] {
  if (sort === "name") return [...projects].sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
  if (sort === "live") return orderByLiveActivity(projects, activeFeatures);
  return applyOrder(projects, order);
}

interface UseOrderedProjectsResult {
  /** Projects in the "Sort projects" order: frozen (see `sidebar-project-order-store`), live or by name. */
  projects: Project[];
  /** True while a (manual or background) projects refetch is in flight. */
  isRefreshing: boolean;
  /** Re-fetch projects and re-adopt the backend's canonical sort order. */
  refresh: () => Promise<void>;
}

/**
 * Projects for the sidebar, ordered with a session-stable freeze.
 *
 * The backend sorts projects by most recent user message on every fetch; this
 * hook keeps that order pinned for the session so projects don't jump around
 * as the user works. `refresh()` re-adopts the fresh backend order (used for
 * an explicit manual refresh); a full app reload also re-sorts since the
 * order store is in-memory.
 */
export function useOrderedProjects(): UseOrderedProjectsResult {
  const query = useListProjects();
  const data = query.data;
  const order = useSidebarProjectOrderStore((s) => s.order);
  const reconcile = useSidebarProjectOrderStore((s) => s.reconcile);

  useEffect(() => {
    if (data) reconcile(data.map((p) => p.id));
  }, [data, reconcile]);

  const sort = useSidebarOption("projectSort");
  const active = useListActiveFeatures({ query: { enabled: sort === "live" } });
  const projects = useMemo(
    () => orderProjects(data ?? [], sort, order, active.data ?? []),
    [active.data, data, order, sort],
  );

  const refresh = useCallback(async (): Promise<void> => {
    // Refetch projects AND every per-project feature list — the latter is what
    // surfaces conversations created on another device. Refetching projects
    // alone (the old behavior) left the sidebar's session rows stale.
    const [result] = await Promise.all([
      query.refetch(),
      queryClient.invalidateQueries({ queryKey: getListFeaturesQueryKey() }),
    ]);
    if (result.data) {
      useSidebarProjectOrderStore.getState().freeze(result.data.map((p) => p.id));
    }
  }, [query]);

  return { projects, isRefreshing: query.isFetching, refresh };
}
