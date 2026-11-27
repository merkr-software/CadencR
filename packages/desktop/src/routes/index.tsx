import { useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useMemo, type ReactElement } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  FeatureStatus,
  useListProjects,
  useListFeatures,
  type Feature,
  type Project,
} from "../api/generated";
import { CenteredMessage, PhoneHomeFrame } from "@/components/PhoneHomeChrome";
import { NewConversation } from "@/components/phone-inbox/PhoneInboxNewConversation";
import { PhoneInbox } from "@/components/phone-inbox/PhoneInbox";
import { useIsMobile } from "@/hooks/useIsMobile";
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
  /** The target project, once loaded: a phone offers New conversation in it. */
  targetProject: Project | undefined;
  /** The phone layout: the sidebar's "+" is behind the menu, so offer the action here. */
  phone: boolean;
}

function HomePageStatus({
  activeFeatureCount,
  featuresLoaded,
  projectsLoaded,
  startupError,
  targetProjectId,
  targetProject,
  phone,
}: HomePageStatusProps): ReactElement {
  const { t } = useUiTranslation();
  if (projectsLoaded && targetProjectId != null && featuresLoaded && activeFeatureCount === 0) {
    if (phone) {
      return (
        <CenteredMessage
          title={t("home.emptyProject.phoneTitle", "No conversations in this project yet")}
          action={
            <NewConversation projects={targetProject ? [targetProject] : []} variant="button" />
          }
        />
      );
    }
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
        detail={
          phone
            ? t("home.noProjects.hintPhone", "Open the menu and use its + button to add a project")
            : t("home.noProjects.hint", "Use the + button in the sidebar to add a project")
        }
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
        tone="error"
      />
    );
  }
  return <CenteredMessage title={t("home.loading", "Loading...")} />;
}

/**
 * `#/`. The desktop layout opens the conversation last opened on this device
 * (else the project's first); the phone layout shows the "Agents" inbox
 * instead, unless a project is asked for (`?projectId=`), which opens as on
 * desktop. A link to a conversation opens it in either layout.
 */
function HomePage(): ReactElement {
  const isMobile = useIsMobile();
  const { projectId: searchProjectId } = Route.useSearch();
  if (isMobile && searchProjectId == null) {
    return <PhoneInbox />;
  }
  return <RestoreConversation phone={isMobile} searchProjectId={searchProjectId} />;
}

function RestoreConversation({
  phone,
  searchProjectId,
}: {
  phone: boolean;
  searchProjectId: number | undefined;
}): ReactElement {
  const navigate = useNavigate();

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

  const status = (
    <HomePageStatus
      activeFeatureCount={activeFeatures.length}
      featuresLoaded={featuresQuery.isSuccess}
      projectsLoaded={projectsQuery.isSuccess}
      startupError={startupError}
      targetProjectId={targetProjectId}
      targetProject={projectsQuery.data?.find((project) => project.id === targetProjectId)}
      phone={phone}
    />
  );
  return phone ? <PhoneHomeFrame>{status}</PhoneHomeFrame> : status;
}
