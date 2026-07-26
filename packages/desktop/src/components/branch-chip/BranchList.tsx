/**
 * Branch-flavoured wrapper over {@link useFilteredVirtualList}.
 *
 * The virtualization, filtering and keyboard wiring are generic and shared with
 * every other searchable picker; all this adds is the knowledge that a branch
 * is matched on its `name`, plus the `branch` field its four callers already
 * destructure.
 */
import { useCallback, type CSSProperties, type ReactElement, type ReactNode } from "react";

import { type BranchInfo } from "@/api/generated";
import { useFilteredVirtualList } from "@/hooks/useFilteredVirtualList";
import { type VirtualizedListNavigation } from "@/hooks/useVirtualizedListNavigation";

export interface BranchListRowContext {
  branch: BranchInfo;
  index: number;
  isActive: boolean;
  open: () => boolean;
}

interface UseBranchListOptions {
  branches: BranchInfo[];
  query: string;
  onPick: (branch: BranchInfo) => void;
  renderRow: (ctx: BranchListRowContext) => ReactNode;
  /** Pixel height of the scroll viewport. Defaults to 320. */
  height?: CSSProperties["height"];
  /** Rendered when filtering removes every branch. */
  emptyState?: ReactNode;
}

interface UseBranchListResult {
  list: ReactElement;
  /** Wire onto the auto-focused input/popover so Up/Down/Enter drive selection. */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Filtered count, useful for parents that need to disable submit when 0. */
  filteredCount: number;
  navigation: VirtualizedListNavigation<BranchInfo>;
}

export function useBranchList({
  branches,
  query,
  onPick,
  renderRow,
  height = 320,
  emptyState,
}: UseBranchListOptions): UseBranchListResult {
  const getLabel = useCallback((branch: BranchInfo) => branch.name, []);
  const renderBranchRow = useCallback(
    ({
      item,
      index,
      isActive,
      open,
    }: { item: BranchInfo } & Omit<BranchListRowContext, "branch">) =>
      renderRow({ branch: item, index, isActive, open }),
    [renderRow],
  );

  return useFilteredVirtualList<BranchInfo>({
    items: branches,
    query,
    getLabel,
    onPick,
    renderRow: renderBranchRow,
    height,
    emptyState,
  });
}
