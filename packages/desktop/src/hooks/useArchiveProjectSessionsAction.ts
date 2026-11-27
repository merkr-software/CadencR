import { translateUi } from "@/lib/i18n/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useArchiveProjectSessions, useListFeatures } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import {
  archiveFeaturesInCachedLists,
  closeFeatureSession,
  navigateToFeatureOrHome,
} from "@/components/project-feature-navigation";

interface UseArchiveProjectSessionsActionOptions {
  activeFeatureId: number | null;
  projectId: number;
}

function keptSessionSummary(pinned: number, running: number): string | undefined {
  if (pinned > 0 && running > 0) {
    return translateUi(
      "project.archiveSessions.keptPinnedAndRunning",
      "{{pinned}} pinned and {{running}} running kept",
      { pinned, running },
    );
  }
  if (pinned > 0) {
    return translateUi("project.archiveSessions.keptPinned", "{{count}} pinned kept", {
      count: pinned,
    });
  }
  if (running > 0) {
    return translateUi("project.archiveSessions.keptRunning", "{{count}} running kept", {
      count: running,
    });
  }
  return undefined;
}

function reportArchiveResult(archived: number, pinned: number, running: number): void {
  const summary =
    archived === 0
      ? translateUi("project.archiveSessions.empty", "No sessions to archive in this project")
      : translateUi("project.archiveSessions.archived", "Archived {{count}} sessions", {
          count: archived,
          defaultValue_one: "Archived {{count}} session",
          defaultValue_other: "Archived {{count}} sessions",
        });
  const kept = keptSessionSummary(pinned, running);
  const message = kept
    ? translateUi("project.archiveSessions.resultWithKept", "{{summary}} ({{kept}})", {
        summary,
        kept,
      })
    : summary;
  if (archived === 0) toast.info(message);
  else toast.success(message);
}

/**
 * Bulk-archives every eligible session of a project (not pinned, no agent
 * turn in flight). Closes the archived workspaces, navigates away when the
 * open session was archived, refreshes the feature lists, and reports how
 * many sessions were archived — and how many were kept — via a toast.
 */
export function useArchiveProjectSessionsAction({
  activeFeatureId,
  projectId,
}: UseArchiveProjectSessionsActionOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: features = [] } = useListFeatures({
    project_id: projectId,
    include_archived: true,
  });
  return useArchiveProjectSessions({
    mutation: {
      onSuccess: (response) => {
        const archivedIds = new Set(response.archived_ids);
        archiveFeaturesInCachedLists(queryClient, response.archived_ids);
        for (const featureId of response.archived_ids) closeFeatureSession(featureId);
        void invalidateByUrlPrefix(queryClient, "/api/features");
        if (activeFeatureId != null && archivedIds.has(activeFeatureId)) {
          const remaining = features.filter(
            (feature) => feature.status === "active" && !archivedIds.has(feature.id),
          );
          navigateToFeatureOrHome(navigate, projectId, remaining[0]);
        }
        reportArchiveResult(
          response.archived_ids.length,
          response.skipped_pinned,
          response.skipped_running,
        );
      },
      onError: (error) => {
        toast.error(
          translateUi("project.archiveSessions.failed", "Could not archive sessions: {{error}}", {
            error: apiErrorMessage(error, translateUi("common.unknownError", "Unknown error")),
          }),
        );
      },
    },
  });
}
