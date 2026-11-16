import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  FeatureStatus,
  getListFeatureWorktreesQueryOptions,
  getListFeaturesQueryOptions,
  getListProjectsQueryOptions,
} from "@/api/generated";
import { useAddProjectAtPath } from "@/hooks/useAddProjectAtPath";
import { apiErrorMessage } from "@/lib/api-errors";
import { followUpdateCheck } from "@/lib/cli/follow-update-check";
import { planCliOpen, type CliOpenPlan, type CliOpenSources } from "@/lib/cli/plan-cli-open";
import { desktopBridge } from "@/lib/desktop-bridge";
import { relativeToProject } from "@/lib/relative-path";
import { readSavedFeature } from "@/lib/saved-feature";
import { useCliFileOpenStore } from "@/stores/cli-file-open-store";
import type { CliRendererItem } from "@/shared/cli-bridge";

type Navigate = ReturnType<typeof useNavigate>;

function openSources(queryClient: QueryClient): CliOpenSources {
  return {
    projects: () => queryClient.fetchQuery(getListProjectsQueryOptions()),
    worktrees: async (projectId) =>
      (
        await queryClient.fetchQuery(getListFeatureWorktreesQueryOptions({ project_id: projectId }))
      ).map((worktree) => ({
        featureId: worktree.feature_id,
        path: worktree.worktree_path,
        live: worktree.live,
        isMainWorktree: worktree.is_main_worktree,
      })),
    activeFeatures: async (projectId) =>
      (
        await queryClient.fetchQuery(
          getListFeaturesQueryOptions({ project_id: projectId, include_archived: false }),
        )
      )
        .filter((feature) => feature.status !== FeatureStatus.archived)
        .map((feature) => ({
          id: feature.id,
          projectId: feature.project_id,
          lastActivityAt: feature.last_activity_at ?? null,
        })),
    lastOpenedFeatureId: () => readSavedFeature()?.featureId ?? null,
  };
}

function applyOpenPlan(plan: CliOpenPlan, path: string, navigate: Navigate): void {
  switch (plan.kind) {
    case "not-in-project":
      toast.error(`${path} is not in a Cadencr project.`, {
        description: "Add its folder first: cadencr add <folder>",
      });
      return;
    case "project":
      void navigate({ to: "/", search: { projectId: plan.projectId } });
      if (plan.notice) toast.info(plan.notice);
      return;
    case "feature":
      if (plan.file) {
        useCliFileOpenStore.getState().request({ featureId: plan.featureId, ...plan.file });
      }
      void navigate({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: String(plan.projectId), featureId: String(plan.featureId) },
      });
      return;
  }
}

function useCliRequestHandler(): (item: CliRendererItem) => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const addProjectAtPath = useAddProjectAtPath();

  const add = useCallback(
    async (path: string) => {
      const projects = await queryClient.fetchQuery(getListProjectsQueryOptions());
      const existing = projects.find((project) => relativeToProject(path, project.path) === "");
      if (existing) {
        toast.info(`${existing.name} is already a project`);
        void navigate({ to: "/", search: { projectId: existing.id } });
        return;
      }
      const toastId = toast.loading("Adding project…");
      try {
        const project = await addProjectAtPath(path);
        toast.success(`Added ${project.name}`, { id: toastId });
        void navigate({ to: "/", search: { projectId: project.id } });
      } catch (error) {
        toast.error(apiErrorMessage(error, "Couldn't add the project"), { id: toastId });
      }
    },
    [addProjectAtPath, navigate, queryClient],
  );

  return useCallback(
    async (item: CliRendererItem) => {
      switch (item.kind) {
        case "error":
          toast.error(item.message);
          return;
        case "update":
          await followUpdateCheck();
          return;
        case "add":
          await add(item.path);
          return;
        case "open": {
          const plan = await planCliOpen(item, openSources(queryClient));
          applyOpenPlan(plan, item.path, navigate);
          return;
        }
      }
    },
    [add, navigate, queryClient],
  );
}

/**
 * Carries out what the `cadencr` command asked the app for. Main queues the
 * requests and pings; this drains them on mount and on every ping, one at a
 * time and in order, so none is missed or run twice.
 */
export function CliRequestBridge(): null {
  const handle = useCliRequestHandler();
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    let disposed = false;
    let chain = Promise.resolve();
    const drain = (): void => {
      chain = chain.then(async () => {
        if (disposed) return;
        let items: CliRendererItem[];
        try {
          items = await desktopBridge.drainCliRequests();
        } catch (error) {
          toast.error(apiErrorMessage(error, "Couldn't read the cadencr command's request"));
          return;
        }
        for (const item of items) {
          try {
            await handleRef.current(item);
          } catch (error) {
            toast.error(apiErrorMessage(error, "The cadencr command's request failed"));
          }
        }
      });
    };
    const unsubscribe = desktopBridge.onCliRequestsPending(drain);
    drain();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return null;
}
