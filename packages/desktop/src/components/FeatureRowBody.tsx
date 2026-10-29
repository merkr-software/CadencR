import type { CSSProperties, ReactElement, ReactNode, RefObject } from "react";
import { FeatureRowLanes } from "@/components/FeatureRowLanes";
import type {
  AllocatedPort,
  Feature,
  FeatureWorktreeInfo,
  GitStats,
  PrStatusSnapshot,
} from "@/api/generated";
import { FeatureRowTitleLine } from "@/components/FeatureRowTitleLine";
import { FeatureRowMetaLine, type FeatureLabelEditing } from "@/components/ProjectFeatureRowParts";
import { FeatureRowPreviewLine } from "@/components/FeatureRowSummaryParts";
import { SidebarNextActionLine } from "@/components/SidebarNextActionLine";
import { SidebarPendingRequestLine } from "@/components/SidebarPendingRequestLine";
import { useFeatureRowSummary } from "@/hooks/useFeatureRowSummary";
import type { NextActionKind } from "@/lib/next-actions";
import type { Attention } from "@/lib/sidebar-attention";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { rowMetaOptions } from "@/lib/sidebar-row-meta";
import {
  fixedRowLineCount,
  rowLayout,
  type RowLayout,
  type RowSummary,
} from "@/lib/sidebar-row-summary";
import { cn } from "@/lib/utils";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useShallow } from "zustand/react/shallow";

export interface FeatureRowBodyProps {
  feature: Feature;
  liveTitle: string | undefined;
  isAutoNaming: boolean;
  isArchived: boolean;
  hasWorktree: boolean;
  worktree: FeatureWorktreeInfo | undefined;
  attention: Attention;
  isActive: boolean;
  badgeRef?: RefObject<HTMLSpanElement | null>;
  onOpenConversation: () => void;
  /** The hover actions, in the title line before the time they replace. */
  actions?: ReactNode;
  /** The next action, named on its own line under the title: only the "For me" block passes it. */
  nextAction?: NextActionKind;
  prStatus: PrStatusSnapshot | undefined;
  gitStats: GitStats | undefined;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
  ports: readonly AllocatedPort[];
  labelEditor?: FeatureLabelEditing;
  onOpenPort: (port: number) => void;
  /** Show one of the conversation's pull requests in its Git tab (`null`: the current branch's). */
  onOpenPr?: (prNumber: number | null) => void;
}

/**
 * What a conversation row shows, wherever it is: the title line, what a
 * waiting conversation asks for (else the agent's last reply), and the
 * details, beside the title (uniform rows) or on their own line. A fixed row
 * fills its lines itself (`FeatureRowLanes`). Compact rows
 * keep only the title line until their conversation waits. A "For me" row also
 * names its next action under the title, in every density, in place of the
 * request line. Takes plain values, so the project tree, the blocks above it
 * and the display options preview render the exact same row from their own
 * data.
 */
export function FeatureRowBody({
  feature,
  liveTitle,
  isAutoNaming,
  isArchived,
  hasWorktree,
  worktree,
  attention,
  isActive,
  badgeRef,
  onOpenConversation,
  actions,
  nextAction,
  prStatus,
  gitStats,
  shellCount,
  browserCount,
  downloadCount,
  ports,
  labelEditor,
  onOpenPort,
  onOpenPr,
}: FeatureRowBodyProps): ReactElement {
  const options = useSidebarConfigStore(useShallow((state) => rowOptions(state.config)));
  const layout = rowLayout(options, attention.state, labelEditor !== undefined);
  const summary = useFeatureRowSummary(
    feature.id,
    attention.state,
    layout.showsPreview || layout.showsTodos,
  );
  // What both the meta line and a fixed row's lines (`FeatureRowLanes`) read their details from.
  const meta = {
    feature,
    worktree,
    prStatus,
    gitStats,
    shellCount,
    browserCount,
    downloadCount,
    ports,
    labelEditor,
    onOpenPort,
    onOpenPr,
    summary,
  };
  const details =
    layout.compact || (layout.fixed && !layout.foldMeta) ? null : (
      <FeatureRowMetaLine {...meta} inline={layout.foldMeta} />
    );
  return (
    <div
      data-feature-row-body
      className={cn("flex min-w-0 flex-1 flex-col", !layout.fixed && "gap-0.5")}
      style={layout.fixed ? fixedRowStyle(layout, nextAction !== undefined) : undefined}
    >
      <FeatureRowTitleLine
        feature={feature}
        liveTitle={liveTitle}
        isAutoNaming={isAutoNaming}
        isArchived={isArchived}
        hasWorktree={hasWorktree}
        worktree={worktree}
        attention={attention}
        isActive={isActive}
        badgeRef={badgeRef}
        onOpenConversation={onOpenConversation}
        details={layout.foldMeta ? details : undefined}
      >
        {actions}
      </FeatureRowTitleLine>
      {layout.fixed ? (
        <FeatureRowLanes
          {...meta}
          layout={layout}
          options={options}
          attention={attention}
          nextAction={nextAction}
        />
      ) : (
        <>
          {nextAction && (
            <SidebarNextActionLine
              kind={nextAction}
              featureId={attention.sourceFeatureId}
              prStatus={prStatus}
            />
          )}
          {!layout.compact && (
            <AutoRowLines
              layout={layout}
              attention={attention}
              namesNextAction={nextAction !== undefined}
              summary={summary}
              details={details}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The lines under an auto-height row's title, each only when it has something to show. */
function AutoRowLines({
  layout,
  attention,
  namesNextAction,
  summary,
  details,
}: {
  layout: RowLayout;
  attention: Attention;
  /** A "For me" row: its next action already took the request line. */
  namesNextAction: boolean;
  summary: RowSummary | undefined;
  details: ReactNode;
}): ReactElement {
  return (
    <>
      {!namesNextAction && <SidebarPendingRequestLine attention={attention} />}
      {layout.showsPreview && <FeatureRowPreviewLine summary={summary} />}
      {!layout.foldMeta && details}
    </>
  );
}

/** A fixed row's height under its title: 20px for each line its options hold (`sidebar-row-height.css`). */
function fixedRowStyle(layout: RowLayout, namesNextAction: boolean): CSSProperties {
  return {
    "--feature-row-detail-height": `${fixedRowLineCount(layout, namesNextAction) * 1.25}rem`,
  } as CSSProperties;
}

function rowOptions(config: SidebarConfig) {
  return {
    ...rowMetaOptions(config),
    compactRows: config.compactRows,
    uniformRows: config.uniformRows,
    titleLines: config.titleLines,
    rowHeight: config.rowHeight,
    preview: config.preview,
    pendingRequest: config.pendingRequest,
  };
}
