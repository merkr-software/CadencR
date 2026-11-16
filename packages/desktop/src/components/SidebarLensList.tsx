import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { Virtuoso } from "react-virtuoso";
import type { Feature } from "@/api/generated";
import { Skeleton } from "@/components/ui/skeleton";
import { PinnedConversationRow } from "@/components/PinnedConversationRow";
import { SidebarLensGroupHeader, STICKY_FILL_CLASS } from "@/components/SidebarLensGroupHeader";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { useFeaturePorts } from "@/hooks/useFeaturePorts";
import { crossProjectRowData, type PinnedActivity } from "@/hooks/usePinnedActivity";
import { useReorderAnimation } from "@/hooks/useReorderAnimation";
import { useSidebarVirtualList } from "@/hooks/useVirtualFeatureFocus";
import type { LensGroup } from "@/lib/sidebar-lens";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarLensStore } from "@/stores/sidebar-lens-store";

type Entry = { kind: "header"; group: LensGroup } | { kind: "row"; feature: Feature };

const INDEX_ATTRIBUTE = "data-lens-entry-index";

interface SidebarLensListProps {
  groups: readonly LensGroup[];
  /** False for one unnamed group (the flat list): rows only. */
  showHeaders: boolean;
  activity: PinnedActivity;
  isPending: boolean;
  emptyText: string;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

function buildEntries(
  groups: readonly LensGroup[],
  folded: ReadonlySet<string>,
  showHeaders: boolean,
): { entries: Entry[]; groupAt: (LensGroup | undefined)[] } {
  const entries: Entry[] = [];
  const groupAt: (LensGroup | undefined)[] = [];
  for (const group of groups) {
    if (showHeaders) {
      entries.push({ kind: "header", group });
      groupAt.push(group);
    }
    if (showHeaders && folded.has(group.key)) continue;
    for (const feature of group.features) {
      entries.push({ kind: "row", feature });
      groupAt.push(group);
    }
  }
  return { entries, groupAt };
}

/**
 * Conversations of every project in one virtualized list: a cross-project
 * lens's groups, each a header and its rows, or a saved view's matches. One
 * list for all of them, so a lens with hundreds of conversations scrolls as
 * lightly as one project does. Keyboard navigation and revealing the open
 * conversation work as in a project's list.
 */
export function SidebarLensList(props: SidebarLensListProps): ReactElement {
  const { groups, showHeaders, activeFeatureId, activity } = props;
  const folded = useSidebarLensStore((state) => state.folded);
  const toggleGroup = useSidebarLensStore((state) => state.toggleGroup);
  const sticky = useSidebarOption("stickyHeaders") && showHeaders;
  const { entries, groupAt } = useMemo(
    () => buildEntries(groups, folded, showHeaders),
    [folded, groups, showHeaders],
  );
  const rowIds = useMemo(
    () => entries.map((entry) => (entry.kind === "row" ? entry.feature.id : null)),
    [entries],
  );
  // Per "Reveal open": only "scroll" brings the open conversation into view.
  const reveal = useSidebarOption("revealActive") === "scroll";
  const list = useSidebarVirtualList(rowIds, activeFeatureId, reveal, INDEX_ATTRIBUTE);
  const featureIds = useMemo(() => rowIds.filter((id) => id !== null), [rowIds]);
  // A drop, or a re-sort, slides rows into place as in a project's list.
  useReorderAnimation(list.rootRef, featureIds);
  const navigate = useCrossProjectNavigate(activeFeatureId, props.onSelectFeature);
  const portsByFeatureId = useFeaturePorts();
  const itemContent = useCallback(
    (index: number, entry: Entry) => (
      <div {...{ [INDEX_ATTRIBUTE]: index }} className="pb-0.5">
        {entry.kind === "header" ? (
          <SidebarLensGroupHeader
            group={entry.group}
            folded={folded.has(entry.group.key)}
            onToggle={toggleGroup}
          />
        ) : (
          <div role="listitem">
            <PinnedConversationRow
              feature={entry.feature}
              activeFeatureId={activeFeatureId}
              {...crossProjectRowData(activity, portsByFeatureId, entry.feature.id)}
              onNavigate={navigate}
            />
          </div>
        )}
      </div>
    ),
    [activeFeatureId, activity, folded, navigate, portsByFeatureId, toggleGroup],
  );

  if (entries.length === 0) {
    return props.isPending ? (
      <Skeleton aria-label="Loading conversations" className="mx-1.5 my-1 h-5" />
    ) : (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground">{props.emptyText}</p>
    );
  }
  return (
    <div
      ref={list.wrapperRef}
      data-virtual-nav-list
      data-sidebar-lens-list
      role="list"
      aria-label="Conversations"
      className="flex min-w-0 flex-col"
    >
      {sticky && list.scrollParent && (
        <StuckGroupHeader
          scrollParent={list.scrollParent}
          rootRef={list.rootRef}
          groupAt={groupAt}
        />
      )}
      {list.scrollParent && (
        <Virtuoso
          ref={list.virtuosoRef}
          customScrollParent={list.scrollParent}
          data={entries}
          initialTopMostItemIndex={Math.max(list.revealIndex, 0)}
          computeItemKey={entryKey}
          rangeChanged={list.handleRangeChanged}
          increaseViewportBy={144}
          itemContent={itemContent}
        />
      )}
    </div>
  );
}

function entryKey(_index: number, entry: Entry): string {
  return entry.kind === "row" ? `row-${entry.feature.id}` : `header-${entry.group.key}`;
}

/**
 * The header of the group whose rows pass under the top of the scroll area,
 * once its own header has scrolled away, held there. Read from the DOM once a
 * frame while scrolling (Virtuoso's range includes the overscan above); its
 * own component, so a change of group re-renders only this copy.
 */
const StuckGroupHeader = memo(function StuckGroupHeader({
  scrollParent,
  rootRef,
  groupAt,
}: {
  scrollParent: HTMLElement;
  rootRef: RefObject<HTMLDivElement | null>;
  groupAt: readonly (LensGroup | undefined)[];
}): ReactElement | null {
  const [stuck, setStuck] = useState<LensGroup | undefined>(undefined);
  const folded = useSidebarLensStore((state) => (stuck ? state.folded.has(stuck.key) : false));
  const toggleGroup = useSidebarLensStore((state) => state.toggleGroup);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scrollParent.getBoundingClientRect().top;
      let index = 0;
      for (const item of rootRef.current?.querySelectorAll(`[${INDEX_ATTRIBUTE}]`) ?? []) {
        if (item.getBoundingClientRect().bottom > top) {
          index = Number(item.getAttribute(INDEX_ATTRIBUTE));
          break;
        }
      }
      // The first group's header still in view needs no copy.
      setStuck(index > 0 ? groupAt[index] : undefined);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scrollParent.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollParent.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [groupAt, rootRef, scrollParent]);
  if (!stuck) return null;
  return (
    <div className="sticky top-0 z-10 h-0">
      <SidebarLensGroupHeader
        group={stuck}
        folded={folded}
        onToggle={toggleGroup}
        className={`absolute inset-x-0 top-0 ${STICKY_FILL_CLASS}`}
      />
    </div>
  );
});
