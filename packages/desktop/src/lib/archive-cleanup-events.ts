import { toast } from "sonner";
import { z } from "zod";
import {
  getGetArchiveCleanupQueryKey,
  getListArchiveCleanupsQueryKey,
  getListFeatureActivityQueryKey,
  getListFeaturesQueryKey,
  type Feature,
} from "@/api/generated";
import {
  archiveFeaturesInCachedLists,
  archiveNavigationTarget,
  closeFeatureSession,
  navigateToFeatureIdOrHome,
} from "@/components/project-feature-navigation";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { apiErrorMessage } from "@/lib/api-errors";
import { isViewingFeature } from "@/lib/notify-agent-done";
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";

const stepSchema = z.object({
  status: z.enum(["pending", "running", "interrupted", "done", "skipped", "blocked", "failed"]),
  detail: z.string().nullish(),
  reason: z.string().nullish(),
  message: z.string().nullish(),
});

export const cleanupReportSchema = z.object({
  terminals: stepSchema.nullish(),
  browser_tabs: stepSchema.nullish(),
  worktree: stepSchema.nullish(),
  branch: stepSchema.nullish(),
});

/** `app/archive_cleanup`: an archive committed, or one of its cleanup steps moved. */
const archiveCleanupEventSchema = z.object({
  project_id: z.number(),
  feature_id: z.number(),
  archived_feature_ids: z.array(z.number()),
  cleanup: cleanupReportSchema,
});

type ArchiveCleanupEvent = z.infer<typeof archiveCleanupEventSchema>;

/**
 * Applies an archive and its cleanup to this client, whoever made it (this
 * window's dialog, another device, an agent): leave and close the archived
 * conversations, tear down the terminal panes whose shells the service
 * killed, and refetch the cleanup this client shows. The service closed the
 * Electron browser tabs itself, through the desktop's bridge.
 */
export function handleArchiveCleanupEvent(payload: unknown): void {
  const parsed = archiveCleanupEventSchema.safeParse(payload);
  if (!parsed.success) {
    // A lagged subscription gets a bare event: refetch everything it covers.
    void invalidateByUrlPrefix(queryClient, "/api/archive-cleanups");
    void invalidateByUrlPrefix(queryClient, "/api/features");
    return;
  }
  const event = parsed.data;
  if (event.archived_feature_ids.length > 0) applyArchive(event);
  applyClosedActivity(event);
  void queryClient.invalidateQueries({ queryKey: getListArchiveCleanupsQueryKey() });
  void queryClient.invalidateQueries({
    queryKey: getGetArchiveCleanupQueryKey(event.feature_id),
  });
}

function applyArchive(event: ArchiveCleanupEvent): void {
  const archivedIds = new Set(event.archived_feature_ids);
  const viewedId = event.archived_feature_ids.find(isViewingFeature);
  // Read before the cached lists mark the conversations archived.
  const target = archiveNavigationTarget(
    cachedActiveFeatures(event.project_id, viewedId),
    viewedId ?? null,
    archivedIds,
  );
  archiveFeaturesInCachedLists(queryClient, event.archived_feature_ids);
  for (const featureId of event.archived_feature_ids) closeFeatureSession(featureId);
  if (target !== undefined) leaveArchivedFeature(event.project_id, target?.id);
}

/** `useCloseFeatureActivity`'s teardown, for the shells and tabs the cleanup closed. */
function applyClosedActivity({ project_id, feature_id, cleanup }: ArchiveCleanupEvent): void {
  const shellsClosed = cleanup.terminals?.status === "done";
  if (shellsClosed) useTerminalStore.getState().closePanel(feature_id);
  if (shellsClosed || cleanup.browser_tabs?.status === "done") {
    void queryClient.invalidateQueries({
      queryKey: getListFeatureActivityQueryKey({ project_id, include_archived: true }),
    });
  }
}

/** The sidebar's active list holding `featureId`, from the cached project lists. */
function cachedActiveFeatures(projectId: number, featureId: number | undefined): Feature[] {
  if (featureId === undefined) return [];
  const list = queryClient
    .getQueriesData<Feature[] | object>({ queryKey: getListFeaturesQueryKey() })
    .map(([, data]) => data)
    .find(
      (data): data is Feature[] =>
        Array.isArray(data) && data.some((feature) => feature.id === featureId),
    );
  return (list ?? []).filter(
    (feature) => feature.project_id === projectId && feature.status === "active",
  );
}

function leaveArchivedFeature(projectId: number, featureId: number | undefined): void {
  // Imported lazily: the router's route tree imports the stores this module is
  // loaded from.
  import("@/router")
    .then(({ router }) => navigateToFeatureIdOrHome(router.navigate, projectId, featureId))
    .catch((error: unknown) => {
      toast.error("Could not leave the archived session", {
        description: apiErrorMessage(error, "Navigation failed"),
      });
    });
}
