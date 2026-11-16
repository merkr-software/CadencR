import { useCallback, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { usePluginTabWorkspace, type PluginTabWorkspace } from "@/api/generated";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { toastError } from "@/lib/api-errors";
import { invalidateByExactUrl, invalidateByUrlPrefix } from "@/lib/queryClient";

type NavigateFn = ReturnType<typeof useNavigate>;

/**
 * Go to the conversation a tab is authored in. The project may have just been
 * created, so the sidebar's lists and the tab summaries (`authoring_project_id`)
 * are refreshed too — a failed refresh is reported, the navigation still happens.
 */
export function goToCustomTabWorkspace(
  navigate: NavigateFn,
  queryClient: QueryClient,
  workspace: PluginTabWorkspace,
): void {
  navigateToFeatureIdOrHome(navigate, workspace.project_id, workspace.feature_id);
  void Promise.all([
    invalidateByExactUrl(queryClient, ["/api/projects", "/api/features"]),
    invalidateByUrlPrefix(queryClient, "/api/plugin-tabs"),
  ]).catch((error: unknown) => {
    toastError(error, "Opened the project, but the project list could not be refreshed");
  });
}

export interface OpenCustomTabProject {
  /** Resolve (creating it when missing) the tab's authoring project and go there. */
  open: (tabId: string, failure: string) => void;
  /** The tab whose project is being resolved, so only its own control waits. */
  openingId: string | null;
}

/**
 * "Open project" and "Retry setup" are the same request: the workspace
 * endpoint is idempotent and recreates whatever part of the project is missing.
 */
export function useOpenCustomTabProject(): OpenCustomTabProject {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync } = usePluginTabWorkspace();
  const [openingId, setOpeningId] = useState<string | null>(null);

  const open = useCallback(
    (tabId: string, failure: string): void => {
      setOpeningId(tabId);
      mutateAsync({ id: tabId })
        .then((workspace) => goToCustomTabWorkspace(navigate, queryClient, workspace))
        .catch((error: unknown) => toastError(error, failure))
        .finally(() => setOpeningId(null));
    },
    [mutateAsync, navigate, queryClient],
  );

  return useMemo(() => ({ open, openingId }), [open, openingId]);
}
