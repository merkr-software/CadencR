import { useMemo, type ReactElement } from "react";
import { useListProjects, type Project } from "@/api/generated";
import { SidebarLensList } from "@/components/SidebarLensList";
import { SidebarReorderProvider } from "@/components/SidebarReorderProvider";
import { useCrossProjectConversations } from "@/hooks/useCrossProjectConversations";
import { useManualConversationOrder } from "@/hooks/useManualConversationOrder";
import {
  buildSidebarGroups,
  isSidebarListReorderable,
  showsGroupHeaders,
  type SidebarListMode,
} from "@/lib/sidebar-views";
import { useSidebarOption } from "@/stores/sidebar-config-store";

const NO_PROJECTS: Project[] = [];

/** Below the blocks, in place of the project tree: a cross-project lens's groups, or a saved view's matches. */
export function SidebarCrossProjectList({
  mode,
  activeFeatureId,
  onSelectFeature,
}: {
  mode: Exclude<SidebarListMode, { kind: "tree" }>;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}): ReactElement {
  const { features, activity, context, isPending } = useCrossProjectConversations("sidebar");
  const sort = useSidebarOption("conversationSort");
  const manualOrder = useManualConversationOrder();
  const { data: projects = NO_PROJECTS } = useListProjects();
  const groups = useMemo(
    () => buildSidebarGroups(features, mode, sort, manualOrder, projects, context),
    [context, features, manualOrder, mode, projects, sort],
  );
  const reorderGroups = useMemo(
    () =>
      isSidebarListReorderable(mode, projects)
        ? groups.map((group) => group.features.map((feature) => feature.id))
        : null,
    [groups, mode, projects],
  );
  return (
    <SidebarReorderProvider groups={reorderGroups}>
      <SidebarLensList
        groups={groups}
        showHeaders={showsGroupHeaders(mode)}
        activity={activity}
        isPending={isPending}
        emptyText={
          mode.kind === "view" ? "No conversation matches this view" : "No conversations yet"
        }
        activeFeatureId={activeFeatureId}
        onSelectFeature={onSelectFeature}
      />
    </SidebarReorderProvider>
  );
}
