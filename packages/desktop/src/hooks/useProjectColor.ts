import { useGetProjectSettings, type ProjectSetting } from "@/api/generated";
import { DEFAULT_PROJECT_COLOR } from "@/lib/project-colors";
import { useSidebarSample } from "@/lib/sidebar-sample-context";

/**
 * Returns the persisted color for a project (or the default if unset).
 *
 * The settings list is fetched once per project per session — `staleTime:
 * Infinity` keeps color dots from triggering a fresh GET on every project-tree
 * mount. Project settings writers invalidate the query, and so does the
 * settings watcher's `settings_event`.
 */
export function useProjectColor(projectId: number): string {
  const sample = useSidebarSample();
  const settings = useProjectSettingsList(projectId);
  if (sample) return sample.projectColors.get(projectId) ?? DEFAULT_PROJECT_COLOR;
  const colorSetting = settings?.find((s) => s.key === "color");
  return colorSetting?.value ?? DEFAULT_PROJECT_COLOR;
}

/**
 * The project's settings list, shared by its color and icon. The display
 * options preview's sample projects don't exist on the service: no fetch there.
 */
export function useProjectSettingsList(projectId: number): ProjectSetting[] | undefined {
  const sample = useSidebarSample();
  const { data } = useGetProjectSettings(projectId, {
    query: { staleTime: Infinity, enabled: sample === null },
  });
  return data;
}
