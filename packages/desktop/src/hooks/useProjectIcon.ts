import { useQuery } from "@tanstack/react-query";
import { useProjectSettingsList } from "@/hooks/useProjectColor";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import { PROJECT_ICON_SETTING_KEY, projectIconBlob, projectIconQueryKey } from "@/lib/project-icon";

/**
 * The icon path configured for a project, or `""` when it should fall back to
 * the accent color dot.
 *
 * Shares the same `staleTime: Infinity` project-settings query as
 * `useProjectColor`, so reading the icon costs no extra request — the settings
 * list is already fetched once per project per session.
 */
function useProjectIconPath(projectId: number): string {
  const settings = useProjectSettingsList(projectId);
  return settings?.find((s) => s.key === PROJECT_ICON_SETTING_KEY)?.value ?? "";
}

/**
 * Resolve a project's icon to a `blob:` URL, or `null` when no icon is set or
 * the file could not be read (deleted, moved, unsupported format).
 *
 * Failures resolve to `null` rather than surfacing an error: this hook feeds
 * the badge rendered in the sidebar, top bar, and several pickers at once, so a
 * missing file must degrade quietly to the color dot instead of firing a toast
 * from every mounted instance. The Project Settings icon field is where a
 * broken path gets reported — see `ProjectIconField`. The display options
 * preview's sample projects answer with their made-up logos.
 */
export function useProjectIconUrl(projectId: number): string | null {
  const sample = useSidebarSample();
  const iconPath = useProjectIconPath(projectId);

  const { data: blob } = useQuery({
    // `iconPath` is a cache-busting token only — it is deliberately NOT sent to
    // the server. Passing it would switch the request to the preview code path
    // (`?path=`), which resolves against the repo and so cannot serve the
    // absolute paths the native file picker allows.
    queryKey: projectIconQueryKey(projectId, iconPath),
    queryFn: ({ signal }) => projectIconBlob(projectId, { signal }),
    enabled: sample === null && iconPath.length > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const url = useObjectUrl(blob);
  return sample ? (sample.projectIcons.get(projectId) ?? null) : url;
}
