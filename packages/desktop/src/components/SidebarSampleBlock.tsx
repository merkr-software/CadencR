import { useMemo, type ReactElement, type ReactNode } from "react";
import { HistoryIcon, InboxIcon, LoaderIcon, PinIcon, type LucideIcon } from "lucide-react";
import { SidebarBlock } from "@/components/SidebarBlock";
import { SidebarSampleRow } from "@/components/SidebarSampleRow";
import { useSamplePreview } from "@/components/SidebarSampleProvider";
import { SidebarShowMoreButton } from "@/components/SidebarShowMore";
import { useForMeShowMore } from "@/hooks/useForMeShowMore";
import { isStrongAction, type NextActionKind } from "@/lib/next-actions";
import { isStrongAttention } from "@/lib/sidebar-attention";
import type { SampleAction, SampleRow } from "@/lib/sidebar-sample-views";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarSectionFold } from "@/hooks/useSidebarSections";
import { SidebarSurfaceContext, type SidebarBlockId } from "@/stores/sidebar-surface-store";

/**
 * One block beside the projects (For me, In progress, Recent, Pinned), filled
 * with samples; hidden like the live block when its option is off.
 */
export function SidebarSampleBlock({ id }: { id: SidebarBlockId }): ReactElement | null {
  const { views } = useSamplePreview();
  const forMeOn = useSidebarOption("forMe");
  const workingOn = useSidebarOption("workingBlock");
  const recentOn = useSidebarOption("recentBlock");
  if (id === "for-me") return forMeOn ? <SampleForMeBlock actions={views.forMe} /> : null;
  if (id === "working") {
    return workingOn ? (
      <SampleBlock
        label="In progress"
        icon={LoaderIcon}
        block="working"
        rows={views.working}
        count={views.working.length}
        empty="No agent at work"
      />
    ) : null;
  }
  if (id === "recent") {
    return recentOn ? (
      <SampleBlock
        label="Recent"
        icon={HistoryIcon}
        block="recent"
        rows={views.recent}
        empty="No conversation yet"
      />
    ) : null;
  }
  return (
    <SampleBlock
      label="Pinned"
      icon={PinIcon}
      block="pinned"
      rows={views.pinned}
      count={views.pinned.length}
      empty="Pin a conversation to keep it here"
      strongCount={views.pinned.filter((row) => isStrongAttention(row.state)).length}
    />
  );
}

interface SampleBlockProps {
  label: string;
  block: SidebarBlockId;
  icon: LucideIcon;
  rows: readonly SampleRow[];
  empty: string;
  /** The header's counter; omitted for blocks whose size is fixed (Recent). */
  count?: number;
  strongCount?: number;
  /** Each row's next action, named under its title (For me). */
  nextActions?: ReadonlyMap<number, NextActionKind>;
  footer?: ReactNode;
}

/** For me's next actions, limited like the live block: the same action lines and "Show more". */
function SampleForMeBlock({ actions }: { actions: readonly SampleAction[] }): ReactElement {
  const more = useForMeShowMore(actions.length);
  const { rows, kinds } = useMemo(() => {
    const shown = actions.slice(0, more.visibleCount);
    return {
      rows: shown.map((action) => action.row),
      kinds: new Map(shown.map((action) => [action.row.conversation.feature.id, action.kind])),
    };
  }, [actions, more.visibleCount]);
  return (
    <SampleBlock
      label="For me"
      icon={InboxIcon}
      block="for-me"
      rows={rows}
      count={actions.length}
      nextActions={kinds}
      footer={<SidebarShowMoreButton more={more} />}
      empty="Nothing waiting on you"
      strongCount={actions.filter(isStrongAction).length}
    />
  );
}

function SampleBlock({
  label,
  icon,
  block,
  rows,
  empty,
  count,
  strongCount,
  nextActions,
  footer,
}: SampleBlockProps): ReactElement | null {
  const preview = useSamplePreview();
  // Folds with the live block of the same name: the preview is the user's sidebar.
  const fold = useSidebarSectionFold(block);
  const hideEmpty = useSidebarOption("hideEmptyBlocks");
  if (rows.length === 0 && hideEmpty) return null;
  return (
    <SidebarBlock
      block={block}
      label={label}
      icon={icon}
      count={count}
      strongCount={strongCount}
      fold={fold}
      empty={empty}
      isEmpty={rows.length === 0}
      capped
    >
      {/* Pinned rows belong to the tree's surface. */}
      <SidebarSurfaceContext.Provider value={block === "pinned" ? "tree" : block}>
        {rows.map((row) => (
          <SidebarSampleRow
            key={row.conversation.feature.id}
            row={row}
            variant="block"
            isActive={row.conversation.feature.id === preview.activeFeatureId}
            onSelect={preview.select}
            nextAction={nextActions?.get(row.conversation.feature.id)}
          />
        ))}
        {footer}
      </SidebarSurfaceContext.Provider>
    </SidebarBlock>
  );
}
