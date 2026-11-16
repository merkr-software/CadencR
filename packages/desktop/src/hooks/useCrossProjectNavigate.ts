import { useCallback, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useListProjects, type Feature, type Project } from "@/api/generated";
import {
  getFocusedTabForFeature,
  type FeatureNavigate,
  type FeatureNavigateOptions,
} from "@/lib/feature-focus-handoff";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";

const NO_PROJECTS: Project[] = [];

/**
 * Opens a conversation from a section that mixes projects (Pinned, For me):
 * resolves its project for the route and keeps the focused tab, like a
 * project row. Stable across active-row changes.
 */
export function useCrossProjectNavigate(
  activeFeatureId: number | null,
  onSelectFeature: (featureId: number) => void,
): FeatureNavigate {
  const navigate = useNavigate();
  const { data: projects = NO_PROJECTS } = useListProjects();
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  // Read the live active id through a ref so the handler's identity doesn't
  // churn every time the open conversation changes.
  const activeFeatureIdRef = useRef(activeFeatureId);
  activeFeatureIdRef.current = activeFeatureId;

  return useCallback(
    (feature: Feature, options?: FeatureNavigateOptions): void => {
      const project = projectsById.get(feature.project_id);
      if (!project) return;
      onSelectFeature(feature.id);
      const focusTab = options?.focusTab ?? getFocusedTabForFeature(activeFeatureIdRef.current);
      void navigate({
        to: "/ws-session/$sessionId",
        params: { sessionId: wsSessionIdFromFeature(feature.id) },
        search: focusTab
          ? { cwd: project.path, featureId: feature.id, projectId: project.id, focusTab }
          : { cwd: project.path, featureId: feature.id, projectId: project.id },
      });
    },
    [navigate, projectsById, onSelectFeature],
  );
}
