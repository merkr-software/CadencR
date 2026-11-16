import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { Feature } from "@/api/generated";
import { descendantIdsOf, type FeatureTreeNode } from "@/lib/feature-hierarchy";
import { Button } from "@/components/ui/button";

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
  const expanded = !collapsedIds.has(node.feature.id);
  const hasChildren = node.children.length > 0;

  const control = hasChildren ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-3 rounded-sm text-muted-foreground/70 hover:text-foreground"
      aria-label={expanded ? "Collapse child sessions" : "Expand child sessions"}
      onClick={(event) => {
        event.stopPropagation();
        onSetCollapsed(node.feature.id, expanded);
      }}
    >
      {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
    </Button>
  ) : null;

  return (
    <>
      {renderFeature(
        node.feature,
        control,
        depth,
        hasChildren && !expanded ? descendantIdsOf(node) : undefined,
      )}
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
