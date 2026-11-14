import { useMemo } from "react";
import { useGetFeature, useGetWorkspaceSetting, usePluginTabList } from "@/api/generated";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import {
  EDITOR_BACKEND_KEY,
  resolveEditorId,
  resolveEditorTarget,
} from "@/lib/editors/editor-registry";
import { useEditorNavigationStore } from "@/lib/editors/editor-navigation-store";
import { useIsMobile } from "./useIsMobile";
import { usePluginTabFeatureProjects } from "@/lib/plugin-tabs/feature-projects";

/** Every surface and opener resolves the same setting and project-scoped catalog. */
export function useEditorBackend(featureId: number, projectId?: number) {
  const setting = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const vim = useGetWorkspaceSetting("editor_vim_mode_level");
  const vimLevel = vim.data?.value ?? "0";
  const id = resolveEditorId(setting.data?.value, vimLevel);
  const mobile = useIsMobile();
  const desktop = pluginTabsAvailable();
  const remembered = usePluginTabFeatureProjects((state) => state.projects[featureId]);
  const feature = useGetFeature(featureId, {
    query: {
      enabled: id.startsWith("plugin:") && projectId === undefined && remembered === undefined,
    },
  });
  const effectiveProjectId = projectId ?? remembered ?? feature.data?.project_id;
  const plugins = usePluginTabList(
    effectiveProjectId === undefined ? undefined : { project_id: effectiveProjectId },
    {
      query: {
        enabled: id.startsWith("plugin:") && effectiveProjectId !== undefined,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  );
  const fallback = useEditorNavigationStore((state) => state.fallbacks[featureId]);
  return useMemo(() => {
    const loading =
      setting.isLoading ||
      (setting.data?.value == null && vim.isLoading) ||
      (id.startsWith("plugin:") &&
        (plugins.isLoading || (effectiveProjectId === undefined && feature.isLoading)));
    const target = resolveEditorTarget({
      id,
      plugins: plugins.data ?? [],
      desktop,
      mobile,
      loading,
    });
    if (setting.isError || (setting.data?.value == null && vim.isError))
      return {
        kind: "codemirror" as const,
        id,
        reason: "The editor setting could not be loaded. Showing CodeMirror.",
      };
    if (plugins.isError && id.startsWith("plugin:"))
      return {
        kind: "codemirror" as const,
        id,
        reason: "The editor catalog could not be loaded. Showing CodeMirror.",
      };
    if (id.startsWith("plugin:") && effectiveProjectId === undefined && feature.isError)
      return {
        kind: "codemirror" as const,
        id,
        reason: "The editor context could not be loaded. Showing CodeMirror.",
      };
    if (fallback?.backendId === id)
      return { kind: "codemirror" as const, id, reason: fallback.reason };
    return target;
  }, [
    desktop,
    effectiveProjectId,
    feature.isError,
    feature.isLoading,
    fallback,
    id,
    mobile,
    plugins.data,
    plugins.isError,
    plugins.isLoading,
    setting.data?.value,
    setting.isError,
    setting.isLoading,
    vim.isError,
    vim.isLoading,
  ]);
}
