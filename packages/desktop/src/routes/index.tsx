import { useEffect, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FeatureStatus, useListProjects, useListFeatures, type Feature } from "../api/generated";
import { readSavedFeature } from "@/lib/saved-feature";

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): { projectId?: number } => {
    const result: { projectId?: number } = {};
    if (search.projectId) result.projectId = Number(search.projectId);
    return result;
  },
});

function getQueryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Failed to load workspace data.";
}

function isRestorableFeature(feature: Feature): boolean {
  return feature.status !== FeatureStatus.archived;
}

function HomePage() {
  const navigate = useNavigate();
  const { projectId: searchProjectId } = Route.useSearch();

  // Per-device session restore — read synchronously from localStorage.
  const lastFeature = useMemo(() => readSavedFeature(), []);

  const projectsQuery = useListProjects();
  const fallbackProjectId = projectsQuery.data?.[0]?.id ?? null;
  const targetProjectId = searchProjectId ?? lastFeature?.projectId ?? fallbackProjectId;

  const featuresQuery = useListFeatures(
    { project_id: targetProjectId ?? 0, include_archived: true },
    { query: { enabled: targetProjectId != null } },
  );
  const activeFeatures = useMemo(
    () => featuresQuery.data?.filter(isRestorableFeature) ?? [],
    [featuresQuery.data],
  );

  const startupError =
    projectsQuery.error ?? (targetProjectId != null ? featuresQuery.error : null);

  useEffect(() => {
    const features = featuresQuery.data;
    if (!features) return;

    // Try saved feature first (unless searchProjectId overrides)
    if (lastFeature && !searchProjectId) {
      const exists = activeFeatures.some((f) => f.id === lastFeature.featureId);
      if (exists && targetProjectId === lastFeature.projectId) {
        void navigate({
          to: "/projects/$projectId/features/$featureId",
          params: {
            projectId: String(lastFeature.projectId),
            featureId: String(lastFeature.featureId),
          },
          replace: true,
        });
        return;
      }
    }

    // Fallback: first feature of target project
    const firstFeatureId = activeFeatures[0]?.id ?? null;
    if (targetProjectId != null && firstFeatureId != null) {
      void navigate({
        to: "/projects/$projectId/features/$featureId",
        params: {
          projectId: String(targetProjectId),
          featureId: String(firstFeatureId),
        },
        replace: true,
      });
    }
  }, [activeFeatures, lastFeature, searchProjectId, targetProjectId, featuresQuery.data, navigate]);

  // Show helpful message if project exists but has no active features.
  if (
    projectsQuery.isSuccess &&
    targetProjectId != null &&
    featuresQuery.isSuccess &&
    activeFeatures.length === 0
  ) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-muted-foreground">No features in this project yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Use the + button in the sidebar to create a new feature
          </p>
        </div>
      </div>
    );
  }

  // Show message if no projects exist
  if (projectsQuery.isSuccess && targetProjectId == null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-muted-foreground">No projects yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Use the + button in the sidebar to add a project
          </p>
        </div>
      </div>
    );
  }

  if (startupError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-destructive">Failed to load workspace</p>
          <p className="mt-2 text-sm text-muted-foreground">{getQueryErrorMessage(startupError)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-muted-foreground">Loading...</p>
    </div>
  );
}
