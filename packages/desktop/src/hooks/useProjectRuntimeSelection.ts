/**
 * The agent and model a *new* conversation in a project would start with —
 * `useResolvedModel` minus the feature level, which doesn't exist yet.
 *
 * The schedule editor uses it so its model chip shows the concrete model a run
 * will use instead of the words "project default": a schedule is read months
 * after it is written, and "whatever the project says" is not something you can
 * check at a glance.
 */
import { useMemo } from "react";
import { useAgentCatalog, useGetProjectProviderSettings } from "@/api/agentRuntime";
import { useGetWorkspaceProviderSettings } from "@/api/agentRuntime";
import { useGetProjectModelSettings, useGetWorkspaceModelSettings } from "@/api/generated";
import { DEFAULT_PROVIDER, resolveRuntimeSelection, type RuntimeSelection } from "@/shared/models";

const STALE_MS = 5 * 60 * 1000;

export function useProjectRuntimeSelection(projectId: number | undefined): RuntimeSelection {
  const catalog = useAgentCatalog({ staleTime: STALE_MS });
  const projectModels = useGetProjectModelSettings(projectId ?? 0, {
    query: { enabled: projectId != null, staleTime: STALE_MS },
  });
  const projectProviders = useGetProjectProviderSettings(projectId ?? 0, {
    enabled: projectId != null,
    staleTime: STALE_MS,
  });
  const workspaceModels = useGetWorkspaceModelSettings({ query: { staleTime: STALE_MS } });
  const workspaceProviders = useGetWorkspaceProviderSettings({ staleTime: STALE_MS });

  return useMemo(
    () =>
      resolveRuntimeSelection({
        agentType: "session",
        providers: catalog.data?.providers,
        defaultProviderId: catalog.data?.default_provider ?? DEFAULT_PROVIDER,
        globalModels: workspaceModels.data,
        globalProviders: workspaceProviders.data,
        projectModels: projectModels.data,
        projectProviders: projectProviders.data,
      }),
    [
      catalog.data,
      projectModels.data,
      projectProviders.data,
      workspaceModels.data,
      workspaceProviders.data,
    ],
  );
}
