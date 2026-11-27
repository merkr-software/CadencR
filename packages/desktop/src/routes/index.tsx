import { useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useMemo, type ReactElement } from "react";
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

function isRestorableFeature(feature: Feature): boolean {
  return feature.status !== FeatureStatus.archived;
}

interface HomePageStatusProps {
  activeFeatureCount: number;
  featuresLoaded: boolean;
  projectsLoaded: boolean;
  startupError: unknown;
  targetProjectId: number | null;
}

function CenteredMessage({
  title,
  detail,
  error = false,
}: {
  title: string;
  detail?: string;
  error?: boolean;
}): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <p className={error ? "text-destructive" : "text-muted-foreground"}>{title}</p>
        {detail ? <p className="mt-2 text-sm text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}

function HomePageStatus({
  activeFeatureCount,
  featuresLoaded,
  projectsLoaded,
  startupError,
  targetProjectId,
}: HomePageStatusProps): ReactElement {
  const { t } = useUiTranslation();
  if (projectsLoaded && targetProjectId != null && featuresLoaded && activeFeatureCount === 0) {
    return (
      <CenteredMessage
        title={t("home.emptyProject.title", "No features in this project yet")}
        detail={t(
          "home.emptyProject.hint",
          "Use the + button in the sidebar to create a new feature",
        )}
      />
    );
  }
  if (projectsLoaded && targetProjectId == null) {
    return (
      <CenteredMessage
        title={t("home.noProjects.title", "No projects yet")}
        detail={t("home.noProjects.hint", "Use the + button in the sidebar to add a project")}
      />
    );
  }
  if (startupError) {
    return (
      <CenteredMessage
        title={t("home.load.title", "Failed to load workspace")}
        detail={
          startupError instanceof Error && startupError.message
            ? startupError.message
            : t("home.load.detail", "Failed to load workspace data.")
        }
        error
      />
    );
  }
  return <CenteredMessage title={t("home.loading", "Loading...")} />;
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

  return (
    <HomePageStatus
      activeFeatureCount={activeFeatures.length}
      featuresLoaded={featuresQuery.isSuccess}
      projectsLoaded={projectsQuery.isSuccess}
      startupError={startupError}
      targetProjectId={targetProjectId}
    />
  );
}
