import { useMemo, type ReactElement, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { Feature } from "@/api/generated";
import { descendantIdsOf, type FeatureTreeNode } from "@/lib/feature-hierarchy";
import { Button } from "@/components/ui/button";
import { useUiTranslation } from "@/lib/i18n/ui";

/**
 * Renders one conversation row. `hiddenDescendantIds` is set when the row's
 * subtree is collapsed, so the row can signal what is folded under it.
 */
export type RenderFeature = (
  feature: Feature,
  hierarchyControl?: ReactNode,
  depth?: number,
  hiddenDescendantIds?: readonly number[],
) => ReactNode;

/**
 * A parent row's twisty: a 12px chevron that folds or unfolds its child
 * conversations without opening the row; on phone a 44px target around it.
 */
export function SubtreeToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-3 rounded-sm text-muted-foreground/70 hover:text-foreground phone:hit-area phone:[--hit-right:-4px]"
      aria-label={
        expanded
          ? t(
              "project.virtualizedProjectFeatureList.collapseChildSessions",
              "Collapse child sessions",
            )
          : t("project.virtualizedProjectFeatureList.expandChildSessions", "Expand child sessions")
      }
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
    </Button>
  );
}

/**
 * Renders an active-feature subtree as a compact, IDE-style indent tree:
 * a chevron twisty on parents and an explicit depth passed to each row.
 * ProjectFeatureRow applies that depth inside the full-width hover target,
 * so siblings stay aligned without guide rails.
 */
export function FeatureSubtree({
  node,
  renderFeature,
  collapsedIds,
  onSetCollapsed,
  depth = 0,
}: {
  node: FeatureTreeNode;
  renderFeature: RenderFeature;
  /** Parent conversations the user collapsed (persisted by the caller). */
  collapsedIds: ReadonlySet<number>;
  onSetCollapsed: (featureId: number, collapsed: boolean) => void;
  depth?: number;
}) {
  const { t } = useUiTranslation();
  const expanded = !collapsedIds.has(node.feature.id);
  const hasChildren = node.children.length > 0;
  const featureId = node.feature.id;
  // Kept across renders: the memoized row compares them, and a conversation
  // switch re-renders this tree without changing either.
  const hiddenDescendantIds = useMemo(
    () => (hasChildren && !expanded ? descendantIdsOf(node) : undefined),
    [expanded, hasChildren, node],
  );
  const control = useMemo(
    () =>
      hasChildren ? (
        <SubtreeToggle expanded={expanded} onToggle={() => onSetCollapsed(featureId, expanded)} />
      ) : null,
    [expanded, featureId, hasChildren, onSetCollapsed, t],
  );

  return (
    <>
      {renderFeature(node.feature, control, depth, hiddenDescendantIds)}
      {expanded && hasChildren && (
        <div data-feature-subtree-children={node.feature.id}>
          {node.children.map((child) => (
            <FeatureSubtree
              key={child.feature.id}
              node={child}
              renderFeature={renderFeature}
              collapsedIds={collapsedIds}
              onSetCollapsed={onSetCollapsed}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </>
  );
}
