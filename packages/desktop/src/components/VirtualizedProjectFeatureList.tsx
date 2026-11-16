import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import type { Feature } from "@/api/generated";
import { Button } from "@/components/ui/button";
import type { WorktreeFeatureGroup } from "@/lib/feature-grouping";
import { descendantIdsOf, type FeatureTreeNode } from "@/lib/feature-hierarchy";
import type { RenderFeature } from "@/components/FeatureSubtree";
import { useSidebarVirtualList } from "@/hooks/useVirtualFeatureFocus";

type FeatureEntry = {
  kind: "feature";
  feature: Feature;
  node: FeatureTreeNode;
  depth: number;
  hasChildren: boolean;
  groupKey?: string;
  groupEnd?: boolean;
};
type GroupEntry = { kind: "group"; group: WorktreeFeatureGroup };
type ListEntry = FeatureEntry | GroupEntry;

interface VirtualizedProjectFeatureListProps {
  activeFeatureId: number | null;
  flatActiveFeatures: readonly Feature[];
  renderFeature: RenderFeature;
  rootNodeByFeatureId: ReadonlyMap<number, FeatureTreeNode>;
  worktreeGroups: readonly WorktreeFeatureGroup[];
}

function appendNode(
  entries: ListEntry[],
  node: FeatureTreeNode,
  depth: number,
  collapsed: ReadonlySet<number>,
  groupKey?: string,
): void {
  entries.push({
    kind: "feature",
    feature: node.feature,
    node,
    depth,
    hasChildren: node.children.length > 0,
    groupKey,
  });
  if (collapsed.has(node.feature.id)) return;
  for (const child of node.children) appendNode(entries, child, depth + 1, collapsed, groupKey);
}

function buildEntries(
  props: VirtualizedProjectFeatureListProps,
  collapsed: ReadonlySet<number>,
): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const group of props.worktreeGroups) {
    entries.push({ kind: "group", group });
    const groupStart = entries.length;
    for (const feature of group.features) {
      const node = props.rootNodeByFeatureId.get(feature.id);
      if (node) appendNode(entries, node, 0, collapsed, group.key);
    }
    const last = entries.at(-1);
    if (entries.length > groupStart && last?.kind === "feature") last.groupEnd = true;
  }
  for (const feature of props.flatActiveFeatures) {
    const node = props.rootNodeByFeatureId.get(feature.id);
    if (node) appendNode(entries, node, 0, collapsed);
  }
  return entries;
}

function findAncestorIds(node: FeatureTreeNode, targetId: number, path: number[]): number[] | null {
  if (node.feature.id === targetId) return path;
  for (const child of node.children) {
    const found = findAncestorIds(child, targetId, [...path, node.feature.id]);
    if (found) return found;
  }
  return null;
}

function useCollapsedNodes(
  props: VirtualizedProjectFeatureListProps,
): [ReadonlySet<number>, (id: number) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    if (props.activeFeatureId == null) return;
    const roots = [
      ...props.worktreeGroups.flatMap((group) => group.features),
      ...props.flatActiveFeatures,
    ];
    const ancestors = roots
      .map((feature) => props.rootNodeByFeatureId.get(feature.id))
      .flatMap((node) => (node ? (findAncestorIds(node, props.activeFeatureId!, []) ?? []) : []));
    if (ancestors.length === 0) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      ancestors.forEach((id) => next.delete(id));
      return next.size === previous.size ? previous : next;
    });
  }, [
    props.activeFeatureId,
    props.flatActiveFeatures,
    props.rootNodeByFeatureId,
    props.worktreeGroups,
  ]);
  const toggle = useCallback((id: number): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

export function VirtualizedProjectFeatureList(
  props: VirtualizedProjectFeatureListProps,
): ReactElement {
  const [collapsed, toggleNode] = useCollapsedNodes(props);
  const entries = useMemo(
    () => buildEntries(props, collapsed),
    [collapsed, props.flatActiveFeatures, props.rootNodeByFeatureId, props.worktreeGroups],
  );
  const rowIds = useMemo(
    () => entries.map((entry) => (entry.kind === "feature" ? entry.feature.id : null)),
    [entries],
  );
  const list = useSidebarVirtualList(
    rowIds,
    props.activeFeatureId,
    true,
    "data-project-feature-index",
  );

  return (
    <div
      ref={list.wrapperRef}
      data-virtual-nav-list
      className="flex flex-col gap-0.5"
      role="list"
      aria-label="Conversations"
    >
      {list.scrollParent ? (
        <Virtuoso
          ref={list.virtuosoRef}
          customScrollParent={list.scrollParent}
          data={entries}
          initialTopMostItemIndex={Math.max(list.revealIndex, 0)}
          computeItemKey={(_index, entry) =>
            entry.kind === "feature" ? `feature-${entry.feature.id}` : `${entry.kind}-${_index}`
          }
          rangeChanged={list.handleRangeChanged}
          increaseViewportBy={144}
          itemContent={(index, entry) => (
            <div data-project-feature-index={index}>
              {renderEntry(entry, props, collapsed, toggleNode)}
            </div>
          )}
        />
      ) : null}
    </div>
  );
}

function renderEntry(
  entry: ListEntry,
  props: VirtualizedProjectFeatureListProps,
  collapsed: ReadonlySet<number>,
  toggleNode: (id: number) => void,
): ReactNode {
  if (entry.kind === "group") {
    return (
      <div className="worktree-group flex items-center gap-1.5 rounded-t-md border px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">
        <GitBranchIcon className="size-3 shrink-0 opacity-70" />
        <span className="truncate">{entry.group.label}</span>
        <span className="shrink-0 opacity-70">({entry.group.features.length})</span>
      </div>
    );
  }
  const control = entry.hasChildren ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-3 rounded-sm text-muted-foreground/70 hover:text-foreground"
      aria-label={
        collapsed.has(entry.feature.id) ? "Expand child sessions" : "Collapse child sessions"
      }
      onClick={(event) => {
        event.stopPropagation();
        toggleNode(entry.feature.id);
      }}
    >
      {collapsed.has(entry.feature.id) ? (
        <ChevronRightIcon className="size-3" />
      ) : (
        <ChevronDownIcon className="size-3" />
      )}
    </Button>
  ) : null;
  return (
    <div
      role="listitem"
      className={
        entry.groupKey
          ? `worktree-group border-x px-1 ${entry.groupEnd ? "rounded-b-md border-b pb-1" : ""}`
          : undefined
      }
    >
      {props.renderFeature(
        entry.feature,
        control,
        entry.depth,
        entry.hasChildren && collapsed.has(entry.feature.id)
          ? descendantIdsOf(entry.node)
          : undefined,
      )}
    </div>
  );
}
