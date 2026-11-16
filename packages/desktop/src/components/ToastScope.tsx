import type { ReactNode } from "react";

import {
  getGetFeatureQueryKey,
  getListActiveFeaturesQueryKey,
  getListProjectsQueryKey,
  type Feature,
  type Project,
} from "@/api/generated";
import { ProjectBadge } from "@/components/ProjectBadge";
import { queryClient } from "@/lib/queryClient";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";

/** Where a toast's operation ran. A feature alone resolves its own project. */
export interface ToastScope {
  projectId?: number;
  featureId?: number;
}

/**
 * A toast description led by the scope line: the project's logo or color dot,
 * its name, and the conversation title when the operation belongs to one.
 * Which toasts carry it: DESIGN.md "Toasts".
 *
 * Resolved from the query cache when the toast is created, never fetched:
 * sonner measures a toast's height once, so a line that appeared after a
 * fetch would spill out of the card. With nothing cached — the sidebar keeps
 * projects and active conversations loaded, so rarely — the toast keeps its
 * plain description.
 */
export function scopedToastDescription(scope: ToastScope, description?: ReactNode): ReactNode {
  const feature = scope.featureId === undefined ? undefined : cachedFeature(scope.featureId);
  const projectId = scope.projectId ?? feature?.project_id;
  const project = projectId === undefined ? undefined : cachedProject(projectId);
  if (!project) return description;
  const featureTitle =
    scope.featureId === undefined ? undefined : (liveTitle(scope.featureId) ?? feature?.title);

  return (
    <>
      <div className="toast-scope">
        <ProjectBadge projectId={project.id} size="xs" />
        <span className="toast-scope-project">{project.name}</span>
        {featureTitle && (
          <>
            <span aria-hidden className="toast-scope-separator">
              ·
            </span>
            <span className="toast-scope-feature">{featureTitle}</span>
          </>
        )}
      </div>
      {description != null && <div>{description}</div>}
    </>
  );
}

function cachedProject(projectId: number): Project | undefined {
  return queryClient
    .getQueryData<Project[]>(getListProjectsQueryKey())
    ?.find((project) => project.id === projectId);
}

function cachedFeature(featureId: number): Feature | undefined {
  return (
    queryClient.getQueryData<Feature>(getGetFeatureQueryKey(featureId)) ??
    queryClient
      .getQueryData<Feature[]>(getListActiveFeaturesQueryKey())
      ?.find((feature) => feature.id === featureId)
  );
}

/** The auto-named title pushed over the socket, ahead of the fetched one. */
function liveTitle(featureId: number): string | undefined {
  const session = useWsSessionStore.getState().sessions[wsSessionIdFromFeature(featureId)];
  return session?.featureTitle ?? undefined;
}
