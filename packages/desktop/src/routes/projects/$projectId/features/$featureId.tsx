import { useUiTranslation } from "@/lib/i18n/ui";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { isAxiosError } from "axios";
import { useGetFeature, useListProjects } from "@/api/generated";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { isTabKind, type TabKind } from "@/stores/feature-layout-schema";
import { apiErrorMessage } from "@/lib/api-errors";

interface FeatureSearch {
  initialDescription?: string;
  focusTab?: TabKind;
}

export const Route = createFileRoute("/projects/$projectId/features/$featureId")({
  component: FeaturePage,
  validateSearch: (search: Record<string, unknown>): FeatureSearch => ({
    initialDescription:
      typeof search.initialDescription === "string" ? search.initialDescription : undefined,
    focusTab: isTabKind(search.focusTab) ? search.focusTab : undefined,
  }),
});

/**
 * Legacy feature route. All features are ws-session now, so this is just a
 * redirect to the ws-session route once the feature row has loaded.
 *
 * The backend now returns 404 when a feature has been deleted (instead of
 * `200 null`); we surface that explicitly so we don't redirect with a phantom
 * id.
 */
function FeaturePage() {
  const { featureId, projectId } = Route.useParams();
  const { focusTab } = Route.useSearch();
  const numericFeatureId = Number(featureId);
  const numericProjectId = Number(projectId);

  const featureQuery = useGetFeature(numericFeatureId);
  const feature = featureQuery.data ?? undefined;

  if (featureQuery.isError) {
    if (isAxiosError(featureQuery.error) && featureQuery.error.response?.status === 404) {
      return <FeatureNotFound featureId={numericFeatureId} />;
    }
    return <FeatureLoadError error={featureQuery.error} onRetry={() => featureQuery.refetch()} />;
  }

  if (!feature) {
    // Still loading the feature row — show nothing rather than redirecting with
    // partial state. The query is small and resolves quickly.
    return null;
  }

  return (
    <WsSessionRedirect
      featureId={numericFeatureId}
      projectId={numericProjectId}
      focusTab={focusTab}
    />
  );
}

function FeatureNotFound({ featureId }: { featureId: number }) {
  const { t } = useUiTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">
        {t("home.feature.missing", "Feature #{{featureId}} not found", { featureId })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("home.feature.deleted", "It may have been deleted from another window.")}
      </p>
      <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
        {t("home.feature.back", "Back to home")}
      </Link>
    </div>
  );
}

function FeatureLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useUiTranslation();
  const message = apiErrorMessage(error, t("home.feature.loadError", "Failed to load feature"));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-destructive">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        {t("common.retry", "Retry")}
      </button>
    </div>
  );
}

function WsSessionRedirect({
  featureId,
  projectId,
  focusTab,
}: {
  featureId: number;
  projectId: number;
  focusTab?: TabKind;
}) {
  const projectsQuery = useListProjects();
  const project = projectsQuery.data?.find((p) => p.id === projectId);

  const wsSessionId = wsSessionIdFromFeature(featureId);

  if (!project) {
    return null; // Loading
  }

  return (
    <Navigate
      to="/ws-session/$sessionId"
      params={{ sessionId: wsSessionId }}
      search={
        focusTab
          ? { cwd: project.path, featureId, projectId, focusTab }
          : { cwd: project.path, featureId, projectId }
      }
      replace
    />
  );
}
