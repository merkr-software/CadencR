import { useMemo } from "react";
import {
  useListProjects,
  usePluginTabList,
  type PluginTabListParams,
  type PluginTabSummary,
  type Project,
} from "@/api/generated";
import type { ProjectOverride } from "./custom-tab-model";

const NO_TABS: PluginTabSummary[] = [];
const NO_PROJECTS: Project[] = [];
const NO_OVERRIDES: ReadonlyMap<number, ProjectOverride> = new Map();
const WITH_PROJECT_OVERRIDES: PluginTabListParams = { project_overrides: true };

export interface CustomTabsData {
  tabs: PluginTabSummary[];
  projects: Project[];
  /** Project overrides per tab id: project id → `true`/`false` (unset projects are absent). */
  overridesFor: (tabId: string) => ReadonlyMap<number, ProjectOverride>;
  isLoading: boolean;
  error: Error | null;
  /** The projects failed to load: the per-project choices shown may be wrong. */
  projectsError: Error | null;
}

/** tab id → project id → override, from the summaries' `project_overrides`. */
function overridesByTab(
  tabs: readonly PluginTabSummary[],
): Map<string, ReadonlyMap<number, ProjectOverride>> {
  return new Map(
    tabs.map((tab) => [
      tab.id,
      new Map(
        (tab.project_overrides ?? []).map(({ project_id, enabled }) => [project_id, enabled]),
      ),
    ]),
  );
}

/**
 * Every local custom tab, the projects they can be switched on in, and each
 * project's override — the list carries all of them (`project_overrides`), so
 * the page makes one request however many projects there are. It shares the
 * generated `/api/plugin-tabs` key prefix, which the `app/plugin_tab_changed`
 * handler and every mutation here invalidate.
 */
export function useCustomTabsData(): CustomTabsData {
  const list = usePluginTabList(WITH_PROJECT_OVERRIDES);
  const projectsQuery = useListProjects();
  const projects = projectsQuery.data ?? NO_PROJECTS;
  const tabs = list.data ?? NO_TABS;
  const overrides = useMemo(() => overridesByTab(tabs), [tabs]);

  return useMemo(
    () => ({
      tabs,
      projects,
      overridesFor: (tabId: string) => overrides.get(tabId) ?? NO_OVERRIDES,
      isLoading: list.isLoading,
      error: list.error ?? null,
      projectsError: projectsQuery.error ?? null,
    }),
    [list.error, list.isLoading, overrides, projects, projectsQuery.error, tabs],
  );
}
