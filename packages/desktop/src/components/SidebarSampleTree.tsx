import { useMemo, useState, type ReactElement } from "react";
import { ArchivedFeatureSection } from "@/components/ArchivedFeatureList";
import { FeatureSubtree, type RenderFeature } from "@/components/FeatureSubtree";
import { ProjectRowLabel } from "@/components/ProjectRowButton";
import { ProjectRowAttention } from "@/components/SidebarAttentionProvider";
import { SidebarSampleRow } from "@/components/SidebarSampleRow";
import { useSamplePreview } from "@/components/SidebarSampleProvider";
import { splitDormant } from "@/hooks/useDormantSplit";
import { buildFeatureForest, type FeatureTreeNode } from "@/lib/feature-hierarchy";
import { outranks } from "@/lib/sidebar-attention";
import { SAMPLE_PROJECTS, type SampleProject } from "@/lib/sidebar-sample-data";
import { byActivity, type SampleRow } from "@/lib/sidebar-sample-views";
import { DAY_MS } from "@/lib/sidebar-time";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SidebarSampleLens } from "@/components/SidebarSampleLens";
import { orderProjects } from "@/hooks/useOrderedProjects";
import { useSidebarListMode } from "@/hooks/useSidebarViews";
import { sortConversations } from "@/lib/sidebar-lens";
import { NO_MANUAL_ORDER } from "@/lib/sidebar-manual-order";
import { PROJECT_ROW_CLASS, STICKY_HEADER_CLASS } from "@/components/SidebarLensGroupHeader";

type Preview = ReturnType<typeof useSamplePreview>;

/**
 * The project list, filled with sample projects: folded ones show their
 * badges. A cross-project lens or a saved view regroups the samples instead.
 */
export function SidebarSampleTree(): ReactElement {
  const preview = useSamplePreview();
  const projectSort = useSidebarOption("projectSort");
  const mode = useSidebarListMode();
  const projects = useMemo(
    () =>
      orderProjects(
        SAMPLE_PROJECTS,
        projectSort,
        null,
        preview.rows.map((row) => row.conversation.feature),
      ),
    [preview.rows, projectSort],
  );
  if (mode.kind !== "tree") return <SidebarSampleLens mode={mode} />;
  return (
    <div data-sidebar-tree className="flex min-w-0 flex-col gap-0.5">
      {projects.map((project) => (
        <SampleProjectRow key={project.id} project={project} preview={preview} />
      ))}
    </div>
  );
}

function SampleProjectRow({
  project,
  preview,
}: {
  project: SampleProject;
  preview: Preview;
}): ReactElement {
  const expanded = preview.expandedProjects.has(project.id);
  const rows = useMemo(
    () => preview.rows.filter((row) => row.conversation.feature.project_id === project.id),
    [preview.rows, project.id],
  );
  const sticky = useSidebarOption("stickyHeaders") && expanded;
  return (
    <div>
      <div
        data-sidebar-sticky-header={sticky || undefined}
        className={sticky ? STICKY_HEADER_CLASS : undefined}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => preview.setProjectExpanded(project.id, !expanded)}
          className={PROJECT_ROW_CLASS}
        >
          <ProjectRowLabel projectId={project.id} name={project.name} expanded={expanded} />
          {!expanded && <ProjectRowAttention projectId={project.id} />}
        </button>
      </div>
      {expanded && (
        <div className="sidebar-project-children">
          <SampleConversations rows={rows} preview={preview} />
        </div>
      )}
    </div>
  );
}

/** A project's conversations as the tree lays them out: nested, pinned ones left out, idle ones folded. */
function SampleConversations({
  rows,
  preview,
}: {
  rows: readonly SampleRow[];
  preview: Preview;
}): ReactElement {
  const after = useSidebarOption("dormantAfter");
  const sort = useSidebarOption("conversationSort");
  const [showDormant, setShowDormant] = useState(false);
  const { activeFeatureId, now } = preview;
  const byId = useMemo(
    () => new Map(rows.map((row) => [row.conversation.feature.id, row])),
    [rows],
  );
  const { awake, dormant } = useMemo(() => {
    const forest = buildFeatureForest(
      sortConversations(
        byActivity(rows).filter((feature) => !feature.is_pinned),
        sort,
        NO_MANUAL_ORDER,
      ),
    );
    const none = { awake: forest, dormant: [] as FeatureTreeNode[] };
    if (after === "never") return none;
    const keepAwake = (featureId: number) =>
      featureId === activeFeatureId || byId.get(featureId)?.state !== "idle";
    return splitDormant(forest, now - Number(after) * DAY_MS, keepAwake) ?? none;
  }, [activeFeatureId, after, byId, now, rows, sort]);

  const renderFeature: RenderFeature = (feature, control, depth, hiddenIds) => {
    const row = byId.get(feature.id);
    if (!row) return null;
    return (
      <SidebarSampleRow
        row={row}
        variant="tree"
        depth={depth}
        hierarchyControl={control}
        foldedSource={hiddenIds && mostUrgent(row, hiddenIds, byId)}
        isActive={feature.id === activeFeatureId}
        onSelect={preview.select}
      />
    );
  };
  const renderSubtree = (node: FeatureTreeNode) => (
    <FeatureSubtree
      key={node.feature.id}
      node={node}
      renderFeature={renderFeature}
      collapsedIds={preview.collapsedParents}
      onSetCollapsed={preview.setParentCollapsed}
    />
  );
  return (
    <div className="flex flex-col gap-0.5">
      {awake.map(renderSubtree)}
      <ArchivedFeatureSection
        label="Dormant"
        features={dormant.map((node) => node.feature)}
        expanded={showDormant}
        onToggle={() => setShowDormant((open) => !open)}
      >
        {dormant.map(renderSubtree)}
      </ArchivedFeatureSection>
    </div>
  );
}

function mostUrgent(
  row: SampleRow,
  hiddenIds: readonly number[],
  byId: ReadonlyMap<number, SampleRow>,
): SampleRow {
  let best = row;
  for (const id of hiddenIds) {
    const hidden = byId.get(id);
    if (hidden && outranks(hidden.state, best.state)) best = hidden;
  }
  return best;
}
