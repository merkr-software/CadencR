import type { ReactElement } from "react";
import { FeatureRowReply } from "@/components/FeatureRowSummaryParts";
import { FeatureRowMetaItems, type FeatureLabelEditing } from "@/components/ProjectFeatureRowParts";
import { SidebarNextActionLine } from "@/components/SidebarNextActionLine";
import { SidebarPendingRequestLine } from "@/components/SidebarPendingRequestLine";
import type { NextActionKind } from "@/lib/next-actions";
import type { Attention } from "@/lib/sidebar-attention";
import {
  hasActivityItems,
  hasCodeItems,
  rowMetaItems,
  rowMetaPart,
  type RowMetaInput,
  type RowMetaOptions,
} from "@/lib/sidebar-row-meta";
import { fixedRowLines, type RowLayout } from "@/lib/sidebar-row-summary";

interface FeatureRowLanesProps extends RowMetaInput {
  layout: RowLayout;
  /** The row's display options, read once by `FeatureRowBody`. */
  options: RowMetaOptions & { pendingRequest: boolean };
  attention: Attention;
  nextAction?: NextActionKind;
  labelEditor?: FeatureLabelEditing;
  onOpenPort: (port: number) => void;
  onOpenPr?: (prNumber: number | null) => void;
}

/**
 * A fixed row's lines under its title, every one of them filled: a "For me"
 * row's next action, the request it waits on, then the agent's last reply,
 * the code (branch, diff, pull request) and the activity around it (label,
 * todos, shells and tabs, ports, model). Each kind of content keeps a line of
 * its own and the reply wraps over the lines this row's details leave
 * (`fixedRowLines`), so every row of a list ends on the same line.
 */
export function FeatureRowLanes({
  layout,
  options,
  attention,
  nextAction,
  ...meta
}: FeatureRowLanesProps): ReactElement {
  const items = rowMetaItems(options, meta);
  const lines = fixedRowLines(layout, {
    namesNextAction: nextAction !== undefined,
    asks: options.pendingRequest && attention.state === "waiting",
    code: hasCodeItems(rowMetaPart(items, "code")),
    // The label editor takes the activity line, label or not.
    activity: meta.labelEditor !== undefined || hasActivityItems(rowMetaPart(items, "activity")),
    editingLabel: meta.labelEditor !== undefined,
  });
  return (
    <>
      {nextAction && (
        <LaneLine>
          <SidebarNextActionLine
            kind={nextAction}
            featureId={attention.sourceFeatureId}
            prStatus={meta.prStatus}
          />
        </LaneLine>
      )}
      {lines.asks && (
        <LaneLine>
          <SidebarPendingRequestLine attention={attention} fillsLine />
        </LaneLine>
      )}
      {lines.replyLines > 0 && <FeatureRowReply summary={meta.summary} lines={lines.replyLines} />}
      {lines.code && (
        <FeatureRowMetaItems {...meta} items={items} labelStyle={options.label} part="code" />
      )}
      {lines.activity && (
        <FeatureRowMetaItems {...meta} items={items} labelStyle={options.label} part="activity" />
      )}
    </>
  );
}

/** One line of text on the details' edge, as tall as a line of chips. */
function LaneLine({ children }: { children: ReactElement }): ReactElement {
  return <div className="flex h-5 min-w-0 shrink-0 items-center pl-5">{children}</div>;
}
