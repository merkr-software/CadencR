import { memo, useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { getPluginTabListQueryOptions, useGetWorkspaceSetting } from "@/api/generated";
import { useEditorNavigationStore } from "@/lib/editors/editor-navigation-store";
import { EditorPresenceRegistry, wantedEditorLeases } from "@/lib/editors/editor-presence";
import { EDITOR_BACKEND_KEY } from "@/lib/editors/editor-registry";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { usePluginTabFeatureProjects } from "@/lib/plugin-tabs/feature-projects";
import { useIsMobile } from "@/hooks/useIsMobile";

export const PluginEditorPresenceKeeper = memo(function PluginEditorPresenceKeeper(): null {
  const setting = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const engaged = useEditorNavigationStore((state) => state.engaged);
  const projects = usePluginTabFeatureProjects((state) => state.projects);
  const mobile = useIsMobile();
  const selected = pluginTabsAvailable() && !mobile ? (setting.data?.value ?? "") : "";
  const projectIds = [
    ...new Set(
      Object.entries(engaged).flatMap(([featureId, id]) =>
        id === selected && selected.startsWith("plugin:")
          ? (projects[Number(featureId)] ?? [])
          : [],
      ),
    ),
  ];
  const lists = useQueries({
    queries: projectIds.map((projectId) =>
      getPluginTabListQueryOptions({ project_id: projectId }, { query: { staleTime: Infinity } }),
    ),
  });
  const failed = lists.some((query) => query.isError);
  useEffect(() => {
    if (failed)
      toast.error("The editor plugin catalog could not be refreshed.", {
        id: "editor-presence-catalog",
      });
  }, [failed]);
  const byProject = new Map(projectIds.map((projectId, index) => [projectId, lists[index]?.data]));
  const wanted = wantedEditorLeases(selected, engaged, projects, (id) => byProject.get(id));
  const key = wanted.map((lease) => lease.instanceId).join("|");
  const latest = useRef(wanted);
  latest.current = wanted;
  const registry = useRef<EditorPresenceRegistry | null>(null);
  useEffect(() => {
    const owned = new EditorPresenceRegistry();
    registry.current = owned;
    owned.sync(latest.current);
    return () => {
      owned.dispose();
      registry.current = null;
    };
  }, []);
  useEffect(() => registry.current?.sync(latest.current), [key]);
  return null;
});
