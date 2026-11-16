import type { ReactElement, ReactNode } from "react";

const FEATURE_NESTING_INDENT_PX = 16;

/**
 * A row's twisty column: its sub-conversations' chevron, indented by nesting
 * depth. Inside a project, `sidebar-rows.css` moves it onto the project's guide.
 */
export function FeatureHierarchyGutter({
  depth = 0,
  children,
}: {
  depth?: number;
  children?: ReactNode;
}): ReactElement {
  return (
    <div
      data-feature-hierarchy-gutter={depth}
      className="flex size-3.5 shrink-0 items-center justify-center"
      style={{ marginInlineStart: depth * FEATURE_NESTING_INDENT_PX }}
    >
      {children}
    </div>
  );
}
