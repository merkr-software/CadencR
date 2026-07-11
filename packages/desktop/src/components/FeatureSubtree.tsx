import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { Feature } from "@/api/generated";
import type { FeatureTreeNode } from "@/lib/feature-hierarchy";
import { Button } from "@/components/ui/button";

/**
 * Renders an active-feature subtree as a compact, IDE-style indent tree:
 * a chevron twisty on parents, a matching spacer on leaves for alignment,
 * and a single left guide rail per nesting level. Rows are visually
 * identical at every depth — only the left indent changes.
 */
export function FeatureSubtree({
  node,
  renderFeature,
  withinTree = false,
}: {
  node: FeatureTreeNode;
  renderFeature: (feature: Feature, hierarchyControl?: ReactNode) => ReactNode;
  withinTree?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  const control = hasChildren ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-4 rounded-sm text-muted-foreground/70 hover:text-foreground"
      aria-label={expanded ? "Collapse child sessions" : "Expand child sessions"}
      onClick={(event) => {
        event.stopPropagation();
        setExpanded((value) => !value);
      }}
    >
      {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
    </Button>
  ) : withinTree ? (
    <span className="size-4 shrink-0" aria-hidden />
  ) : null;

  return (
    <>
      {renderFeature(node.feature, control)}
      {expanded && hasChildren && (
        <div data-feature-subtree-children={node.feature.id} className="relative ml-3 pl-2">
          {/* Guide rail, centered under the parent chevron (pl-3 + half of the
              size-4 twisty = 20px from the row's left edge). Self-similar at
              every depth since row and rail share the same left origin. */}
          <span aria-hidden className="absolute inset-y-0 left-2 w-px bg-sidebar-border" />
          {node.children.map((child) => (
            <FeatureSubtree
              key={child.feature.id}
              node={child}
              renderFeature={renderFeature}
              withinTree
            />
          ))}
        </div>
      )}
    </>
  );
}
