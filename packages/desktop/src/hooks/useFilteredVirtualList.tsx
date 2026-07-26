/**
 * Query-filtered, virtualized, keyboard-navigable list — the shape every
 * searchable picker in the app renders.
 *
 * `BranchPicker`, the command palette's worktree step, the branches view and
 * the schedule target picker all need the same four things: a case-insensitive
 * substring filter, a `<Virtuoso>` with a bounded height, arrow/Enter selection
 * from `useVirtualizedListNavigation`, and an empty state. Only the row markup
 * differs, so that is the one thing callers supply.
 *
 * The keyboard handler is returned rather than attached, because the element
 * that actually holds focus varies (an auto-focused input in one picker, the
 * popover itself in another).
 */
import { useCallback, useMemo, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";

import {
  useVirtualizedListNavigation,
  type VirtualizedListNavigation,
} from "@/hooks/useVirtualizedListNavigation";

export interface FilteredVirtualListRowContext<T> {
  item: T;
  index: number;
  isActive: boolean;
  /** Select this row and fire `onPick`. */
  open: () => boolean;
}

export interface UseFilteredVirtualListOptions<T> {
  items: T[];
  query: string;
  /** The text `query` is matched against. */
  getLabel: (item: T) => string;
  onPick: (item: T) => void;
  renderRow: (ctx: FilteredVirtualListRowContext<T>) => ReactNode;
  /** Pixel height of the scroll viewport. Defaults to 320. */
  height?: CSSProperties["height"];
  /** When set, the viewport shrinks to fit a short result set instead of
   *  leaving `height` of empty space below the last row. */
  rowHeight?: number;
  /** Rendered when filtering removes every item. */
  emptyState?: ReactNode;
}

export interface UseFilteredVirtualListResult<T> {
  list: ReactElement;
  /** Wire onto the focused input/popover so Up/Down/Enter drive selection. */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Useful for parents that disable submit when nothing matches. */
  filteredCount: number;
  /** Index into the *filtered* set. Exposed so a combobox parent can point
   *  `aria-activedescendant` at the row the arrow keys landed on. */
  activeIndex: number;
  navigation: VirtualizedListNavigation<T>;
}

export function useFilteredVirtualList<T>({
  items,
  query,
  getLabel,
  onPick,
  renderRow,
  height = 320,
  rowHeight,
  emptyState,
}: UseFilteredVirtualListOptions<T>): UseFilteredVirtualListResult<T> {
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => getLabel(item).toLowerCase().includes(needle));
  }, [getLabel, items, query]);

  const { activeIndex, viewportRef, virtuosoRef, onKeyDown, navigation } =
    useVirtualizedListNavigation(filtered, onPick);

  const itemContent = useCallback(
    (index: number) => {
      const item = filtered[index];
      if (!item) return null;
      return renderRow({
        item,
        index,
        isActive: index === activeIndex,
        open: () => navigation.openIndex(index),
      });
    },
    [activeIndex, filtered, navigation, renderRow],
  );

  const viewportHeight =
    rowHeight != null && typeof height === "number"
      ? Math.min(height, filtered.length * rowHeight)
      : height;

  const list =
    filtered.length === 0 ? (
      <>{emptyState ?? null}</>
    ) : (
      <div ref={viewportRef} style={{ height: viewportHeight }}>
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: "100%" }}
          totalCount={filtered.length}
          itemContent={itemContent}
        />
      </div>
    );

  return { list, onKeyDown, filteredCount: filtered.length, activeIndex, navigation };
}
