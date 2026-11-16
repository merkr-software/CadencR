import { useRef, useState } from "react";
import { ArchivedFeatureList, ArchivedFeatureSection } from "@/components/ArchivedFeatureList";
import { FeatureArchiveDialogs } from "@/components/FeatureArchiveDialogs";
import {
  useProjectFeaturesController,
  type ProjectFeaturesController,
  type ProjectFeaturesProps,
} from "@/components/ProjectFeaturesController";
import { WorktreeGroup } from "@/components/WorktreeGroup";
import { VirtualizedProjectFeatureList } from "@/components/VirtualizedProjectFeatureList";
import { VirtualizedArchivedFeatureList } from "@/components/VirtualizedArchivedFeatureList";
import { useReorderAnimation } from "@/hooks/useReorderAnimation";
import { SidebarReorderProvider } from "@/components/SidebarReorderProvider";

export function ProjectFeatures(props: ProjectFeaturesProps) {
  const controller = useProjectFeaturesController(props);
  const virtualizeActive = controller.renderedActiveFeatureCount > 20;
  const virtualizeArchived = controller.archivedFeatures.length > 20;
  const listRef = useRef<HTMLDivElement>(null);
  useReorderAnimation(listRef, controller.orderedIds);
  return (
    <SidebarReorderProvider groups={controller.reorderGroups}>
      <div ref={listRef} className="flex flex-col gap-0.5">
        {virtualizeActive ? (
          <VirtualizedProjectFeatureList
            activeFeatureId={props.activeFeatureId}
            flatActiveFeatures={controller.flatActiveFeatures}
            renderFeature={controller.renderFeature}
            rootNodeByFeatureId={controller.rootNodeByFeatureId}
            worktreeGroups={controller.worktreeGroups}
          />
        ) : (
          <>
            {controller.worktreeGroups.map((group) => (
              <WorktreeGroup
                key={group.key}
                label={group.label}
                features={group.features}
                renderFeature={controller.renderSubtree}
              />
            ))}
            {controller.flatActiveFeatures.map(controller.renderSubtree)}
          </>
        )}
        <DormantFeatureList controller={controller} />
        <ProjectFeatureDialogs projectId={props.projectId} controller={controller} />
        {virtualizeArchived ? (
          <VirtualizedArchivedFeatureList
            features={controller.archivedFeatures}
            expanded={controller.showArchived}
            onToggle={controller.toggleArchived}
            renderFeature={controller.renderFeature}
            activeFeatureId={props.activeFeatureId}
          />
        ) : (
          <ArchivedFeatureList
            features={controller.archivedFeatures}
            expanded={controller.showArchived}
            onToggle={controller.toggleArchived}
            renderFeature={controller.renderFeature}
          />
        )}
      </div>
    </SidebarReorderProvider>
  );
}

/** Conversations idle for a while, folded until asked for (G9). */
function DormantFeatureList({ controller }: { controller: ProjectFeaturesController }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ArchivedFeatureSection
      label="Dormant"
      features={controller.dormantFeatures}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      {controller.dormantFeatures.map(controller.renderSubtree)}
    </ArchivedFeatureSection>
  );
}

function ProjectFeatureDialogs({
  projectId,
  controller,
}: {
  projectId: number;
  controller: ProjectFeaturesController;
}) {
  return (
    <FeatureArchiveDialogs
      projectId={projectId}
      confirmFeatureId={controller.confirmFeatureId}
      confirmation={controller.confirmation}
      onClose={() => controller.setConfirmFeatureId(null)}
      onArchive={controller.actions.archiveFeature}
      onDelete={controller.actions.deleteFeature}
    />
  );
}
