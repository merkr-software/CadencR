import type { QueryClient } from "@tanstack/react-query";
import {
  getGetFeatureQueryOptions,
  getGetWorkspaceSettingQueryOptions,
  getPluginTabListQueryOptions,
} from "@/api/generated";
import { EDITOR_VIM_MODE_LEVEL_KEY } from "@/lib/vim-mode-level";
import { usePluginTabFeatureProjects } from "@/lib/plugin-tabs/feature-projects";
import { EDITOR_BACKEND_KEY, resolveEditorId, resolveEditorTarget } from "./editor-registry";

/** Reuse cached settings, but refetch invalidated choices before dispatching. */
export async function readEditorTarget(
  queryClient: QueryClient,
  featureId: number,
  environment: { desktop: boolean; mobile: boolean },
  selected?: (id: string) => void,
) {
  const [backend, vim] = await Promise.all([
    queryClient.fetchQuery(
      getGetWorkspaceSettingQueryOptions(EDITOR_BACKEND_KEY, { query: { staleTime: Infinity } }),
    ),
    queryClient.fetchQuery(
      getGetWorkspaceSettingQueryOptions(EDITOR_VIM_MODE_LEVEL_KEY, {
        query: { staleTime: Infinity },
      }),
    ),
  ]);
  const id = resolveEditorId(backend.value, vim.value ?? "0");
  selected?.(id);
  if (!id.startsWith("plugin:") || !environment.desktop || environment.mobile)
    return resolveEditorTarget({ id, plugins: [], ...environment });
  const remembered = usePluginTabFeatureProjects.getState().projects[featureId];
  const projectId =
    remembered ??
    (await queryClient.ensureQueryData(getGetFeatureQueryOptions(featureId))).project_id;
  const plugins = await queryClient.fetchQuery(
    getPluginTabListQueryOptions({ project_id: projectId }, { query: { staleTime: Infinity } }),
  );
  return resolveEditorTarget({ id, plugins, ...environment });
}
