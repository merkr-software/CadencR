import type { ReactElement } from "react";
import {
  ArchiveIcon,
  DownloadIcon,
  GitBranchIcon,
  GlobeIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  TrashIcon,
} from "lucide-react";
import type {
  AllocatedPort,
  Feature,
  FeatureWorktreeInfo,
  GitStats,
  PrStatusSnapshot,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { FeatureLabelChip } from "@/components/FeatureLabelChip";
import { FeatureMetaBadge } from "@/components/FeatureMetaBadge";
import { FeaturePortsBadge } from "@/components/FeaturePortsBadge";
import { FeatureLabelEditor } from "@/components/FeatureLabelEditor";
import { FeaturePrIndicator } from "@/components/PrStatusIndicators";
import { FeatureTodoProgress } from "@/components/FeatureRowSummaryParts";
import type { RowSummary } from "@/lib/sidebar-row-summary";
import { NumStat } from "@/components/NumStat";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useShallow } from "zustand/react/shallow";
import type { SidebarConfig } from "@/lib/sidebar-config";
import {
  hasActivityItems,
  hasCodeItems,
  rowMetaItems,
  rowMetaOptions,
  rowMetaPart,
  type RowMetaItems,
  type RowMetaPart,
} from "@/lib/sidebar-row-meta";
import { branchTail } from "@/lib/thread-prs";
import { cn } from "@/lib/utils";

interface FeatureRowMetaLineProps {
  feature: Feature;
  worktree: FeatureWorktreeInfo | undefined;
  prStatus: PrStatusSnapshot | undefined;
  gitStats: GitStats | undefined;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
  ports: readonly AllocatedPort[];
  /** Present while the label is being edited; read-only rows never pass it. */
  labelEditor?: FeatureLabelEditing;
  onOpenPort: (port: number) => void;
  /** Show one of the conversation's pull requests in its Git tab (`null`: the current branch's). */
  onOpenPr?: (prNumber: number | null) => void;
  /** Feeds the todo progress, shown while some are left (when the option is on). */
  summary?: RowSummary;
  /** Beside the title (uniform rows): the items join the title line's flow. */
  inline?: boolean;
  /** One part of the details on a line of its own (a fixed row's code or activity line). */
  part?: RowMetaPart;
}

export interface FeatureLabelEditing {
  draft: string;
  suggestions: readonly string[];
  isSaving: boolean;
  onDraftChange: (value: string) => void;
  onSave: (override?: string) => void;
  onCancel: () => void;
}

/**
 * A sidebar feature row's details: label, branch, diff stat, pull-request
 * state, todo progress and running-activity badges, each one switchable in the
 * display options. Its own line under the title, or (`inline`) items that sit
 * beside the title as far as they fit. Renders nothing when the row has none of
 * them to show, so a bare row stays a single line.
 */
export function FeatureRowMetaLine(props: FeatureRowMetaLineProps): ReactElement | null {
  const show = useSidebarConfigStore(useShallow((state) => rowMetaOptions(state.config)));
  return (
    <FeatureRowMetaItems {...props} items={rowMetaItems(show, props)} labelStyle={show.label} />
  );
}

/** The details from items already worked out: a fixed row's lines share one pass for both parts. */
export function FeatureRowMetaItems({
  feature,
  prStatus,
  shellCount,
  browserCount,
  downloadCount,
  ports,
  labelEditor,
  onOpenPort,
  onOpenPr,
  inline = false,
  part,
  items: all,
  labelStyle,
}: FeatureRowMetaLineProps & {
  items: RowMetaItems;
  labelStyle: SidebarConfig["label"];
}): ReactElement | null {
  const items = rowMetaPart(all, part);
  const { branch, model, stats, todos } = items;
  // The label editor belongs with the label, never on the code line.
  const editor = part === "code" ? undefined : labelEditor;
  if (!editor && !hasCodeItems(items) && !hasActivityItems(items)) return null;

  return (
    <div
      data-feature-meta-line
      data-feature-meta-part={part}
      className={
        inline
          ? "contents text-[11px]"
          : cn(
              "flex min-w-0 items-center gap-2 pl-5 text-[11px] leading-tight",
              part && "h-5 shrink-0",
            )
      }
    >
      <MetaLineLabel feature={feature} label={items.label} style={labelStyle} editor={editor} />
      {branch && (
        <span
          data-feature-branch
          title={branch}
          className="inline-flex min-w-0 items-center gap-1 text-muted-foreground"
        >
          <GitBranchIcon className="size-3 shrink-0" aria-hidden />
          {/* A line of its own names the branch by its last segment: the
              shared prefix would leave room for nothing else. */}
          <span className="truncate font-mono text-[10.5px]">
            {part ? branchTail(branch) : branch}
          </span>
        </span>
      )}
      {model && (
        <span
          data-feature-model
          title={model}
          className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground"
        >
          {model}
        </span>
      )}
      {stats && (
        <span data-feature-diff className="inline-flex shrink-0">
          <NumStat
            additions={stats.insertions}
            deletions={stats.deletions}
            className="text-[11px] leading-tight"
          />
        </span>
      )}
      {items.pr && <FeaturePrIndicator snapshot={prStatus} onOpen={onOpenPr} />}
      {todos && <FeatureTodoProgress summary={todos} />}
      {items.activity && (
        <FeatureActivityIndicators
          shellCount={shellCount}
          browserCount={browserCount}
          downloadCount={downloadCount}
        />
      )}
      {items.ports && <FeaturePortsBadge ports={ports} onOpenPort={onOpenPort} />}
    </div>
  );
}

/** The label in its chosen style, or its editor while it is being edited. */
function MetaLineLabel({
  feature,
  label,
  style,
  editor,
}: {
  feature: Feature;
  label: string | null | undefined;
  style: SidebarConfig["label"];
  editor: FeatureLabelEditing | undefined;
}): ReactElement | null {
  if (!editor) {
    return style === "dot" ? <FeatureLabelDot label={label} /> : <FeatureLabelChip label={label} />;
  }
  return (
    <FeatureLabelEditor
      value={editor.draft}
      suggestions={editor.suggestions}
      isSaving={editor.isSaving}
      trigger={
        feature.label ? (
          <FeatureLabelChip label={feature.label} />
        ) : (
          <span className="rounded border border-dashed border-border px-1.5 py-0 font-mono text-[10.5px] leading-4 text-muted-foreground">
            Set label
          </span>
        )
      }
      onChange={editor.onDraftChange}
      onSave={editor.onSave}
      onCancel={editor.onCancel}
    />
  );
}

/** The quiet label style: a dot that names the label on hover. */
function FeatureLabelDot({ label }: { label: string | null | undefined }): ReactElement | null {
  if (!label) return null;
  return (
    <span
      role="img"
      data-feature-label
      aria-label={`Label: ${label}`}
      title={label}
      className="size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}

/**
 * Both the hover affordance and the context menu name these actions by what the
 * click will do, so the wording lives next to the state it reads.
 */
export function pinActionLabel(isPinned: boolean): string {
  return isPinned ? "Unpin" : "Pin";
}

/** Archiving is reversible; a second pass on an archived row deletes it. */
export function archiveActionLabel(isArchived: boolean): string {
  return isArchived ? "Delete" : "Archive";
}

/**
 * Trailing hover affordances: pin and archive/delete. Rendered inside the row's
 * click target, so both stop propagation rather than navigating.
 */
export function FeatureRowActions({
  featureId,
  isArchived,
  isPinned,
  onTogglePin,
  onArchiveOrDelete,
}: {
  featureId: number;
  isArchived: boolean;
  isPinned: boolean;
  onTogglePin: (featureId: number, pinned: boolean) => void;
  onArchiveOrDelete: (featureId: number) => void;
}): ReactElement {
  return (
    <div className="sidebar-row-actions shrink-0 items-center gap-1">
      {!isArchived && (
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={isPinned}
          className={`size-6 shrink-0 p-0 hover:text-foreground transition-none ${
            isPinned ? "text-foreground" : "text-muted-foreground"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(featureId, !isPinned);
          }}
        >
          {isPinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          <span className="sr-only">{pinActionLabel(isPinned)}</span>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground transition-none"
        onClick={(e) => {
          e.stopPropagation();
          onArchiveOrDelete(featureId);
        }}
      >
        {isArchived ? <TrashIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
        <span className="sr-only">{archiveActionLabel(isArchived)}</span>
      </Button>
    </div>
  );
}

function FeatureActivityIndicators({
  shellCount,
  browserCount,
  downloadCount,
}: {
  shellCount: number;
  browserCount: number;
  downloadCount: number;
}): ReactElement | null {
  if (shellCount <= 0 && browserCount <= 0 && downloadCount <= 0) return null;
  return (
    <span data-feature-activity-indicators className="inline-flex shrink-0 items-center gap-1">
      <FeatureActivityBadge
        kind="shell"
        count={shellCount}
        labelSingular="shell command running"
        labelPlural="shell commands running"
        icon={<TerminalIcon className="size-3" />}
      />
      <FeatureActivityBadge
        kind="browser"
        count={browserCount}
        labelSingular="browser tab open"
        labelPlural="browser tabs open"
        icon={<GlobeIcon className="size-3" />}
      />
      <FeatureActivityBadge
        kind="download"
        count={downloadCount}
        labelSingular="browser download active"
        labelPlural="browser downloads active"
        icon={<DownloadIcon className="size-3" />}
      />
    </span>
  );
}

function FeatureActivityBadge({
  kind,
  count,
  labelSingular,
  labelPlural,
  icon,
}: {
  /** Names the badge for the row CSS (each kind takes its own color in "Increased"). */
  kind: "shell" | "browser" | "download";
  count: number;
  labelSingular: string;
  labelPlural: string;
  icon: ReactElement;
}): ReactElement | null {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? labelSingular : labelPlural}`;
  return (
    <span data-feature-activity={kind} className="contents">
      <FeatureMetaBadge icon={icon} label={label}>
        <span>{count}</span>
      </FeatureMetaBadge>
    </span>
  );
}
