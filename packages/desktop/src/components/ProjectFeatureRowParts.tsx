import type { ReactElement } from "react";
import {
  ArchiveIcon,
  GitBranchIcon,
  GlobeIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  TrashIcon,
} from "lucide-react";
import type { AllocatedPort, Feature, GitStats, PrStatusSnapshot } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureLabelChip } from "@/components/FeatureLabelChip";
import { FeatureMetaBadge } from "@/components/FeatureMetaBadge";
import { FeaturePortsBadge } from "@/components/FeaturePortsBadge";
import { FeatureLabelEditor } from "@/components/FeatureLabelEditor";
import { FeaturePrIndicator } from "@/components/PrStatusIndicators";
import { NumStat } from "@/components/NumStat";
import { SidebarPendingGatePopover } from "@/components/SidebarPendingGatePopover";
import { SidebarProviderBadge } from "@/components/SidebarProviderBadge";
import { useProviderMetadata } from "@/lib/provider-icons";
import type { LiveAgentStatus } from "@/stores/session-status-store";

interface FeatureRowMetaLineProps {
  feature: Feature;
  prStatus: PrStatusSnapshot | undefined;
  gitStats: GitStats | undefined;
  shellCount: number;
  browserCount: number;
  ports: readonly AllocatedPort[];
  isEditingLabel: boolean;
  labelDraft: string;
  labelSuggestions: readonly string[];
  isSavingLabel: boolean;
  onLabelDraftChange: (value: string) => void;
  onSaveLabel: (featureId: number, override?: string) => void;
  onCancelLabelEdit: () => void;
  onOpenPort: (port: number) => void;
}

/**
 * Second line of a sidebar feature row: label, diff stat, pull-request state,
 * and running-activity badges. Renders nothing when the row has none of them,
 * so a bare row stays a single line.
 */
export function FeatureRowMetaLine({
  feature,
  prStatus,
  gitStats,
  shellCount,
  browserCount,
  ports,
  isEditingLabel,
  labelDraft,
  labelSuggestions,
  isSavingLabel,
  onLabelDraftChange,
  onSaveLabel,
  onCancelLabelEdit,
  onOpenPort,
}: FeatureRowMetaLineProps): ReactElement | null {
  const hasStats = gitStats != null && (gitStats.insertions > 0 || gitStats.deletions > 0);
  // `FeaturePrIndicator` also renders for an error with no proposal — a forge
  // auth failure must not be the one thing that keeps this line from mounting.
  const hasPrIndicator = prStatus?.pr != null || prStatus?.error != null;
  const hasActivity = shellCount > 0 || browserCount > 0 || ports.length > 0;
  if (!isEditingLabel && !feature.label && !hasStats && !hasActivity && !hasPrIndicator) {
    return null;
  }

  return (
    <div
      data-feature-meta-line
      className="flex min-w-0 items-center gap-2 text-[11px] leading-tight"
    >
      {isEditingLabel ? (
        <FeatureLabelEditor
          value={labelDraft}
          suggestions={labelSuggestions}
          isSaving={isSavingLabel}
          trigger={
            feature.label ? (
              <FeatureLabelChip label={feature.label} />
            ) : (
              <span className="rounded border border-dashed border-border px-1.5 py-0 font-mono text-[10.5px] leading-4 text-muted-foreground">
                Set label
              </span>
            )
          }
          onChange={onLabelDraftChange}
          onSave={(override) => onSaveLabel(feature.id, override)}
          onCancel={onCancelLabelEdit}
        />
      ) : (
        <FeatureLabelChip label={feature.label} />
      )}
      {hasStats && (
        <NumStat
          additions={gitStats.insertions}
          deletions={gitStats.deletions}
          className="text-[11px] leading-tight"
        />
      )}
      <FeaturePrIndicator snapshot={prStatus} />
      <FeatureActivityIndicators shellCount={shellCount} browserCount={browserCount} />
      <FeaturePortsBadge ports={ports} onOpenPort={onOpenPort} />
    </div>
  );
}

/**
 * First line of a row: provider mark (idle mono, status-tinted while live),
 * worktree marker, and the title (a skeleton while the agent is still naming
 * the conversation).
 */
export function FeatureRowTitleLine({
  feature,
  liveTitle,
  isAutoNaming,
  isArchived,
  hasWorktree,
  liveStatus,
  isActive,
  isUnread,
  onOpenConversation,
}: {
  feature: Feature;
  liveTitle: string | undefined;
  isAutoNaming: boolean;
  isArchived: boolean;
  hasWorktree: boolean;
  liveStatus: LiveAgentStatus;
  isActive: boolean;
  isUnread: boolean;
  onOpenConversation: () => void;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <FeatureRowProviderMark
        feature={feature}
        liveStatus={liveStatus}
        isActive={isActive}
        isUnread={isUnread}
        onOpenConversation={onOpenConversation}
      />
      {hasWorktree && (
        <GitBranchIcon
          className="size-3 shrink-0 text-muted-foreground"
          aria-label="Has worktree"
        />
      )}
      {isAutoNaming ? (
        <Skeleton className="h-4 w-32 min-w-0" />
      ) : (
        <span className={`min-w-0 truncate ${isArchived ? "text-muted-foreground" : ""}`}>
          {liveTitle ?? feature.title}
        </span>
      )}
    </div>
  );
}

/** One 14px slot: provider silhouette, status-tinted, gate wrap when waiting. */
export function FeatureRowProviderMark({
  feature,
  liveStatus,
  isActive,
  isUnread,
  onOpenConversation,
}: {
  feature: Feature;
  liveStatus: LiveAgentStatus;
  isActive: boolean;
  isUnread: boolean;
  onOpenConversation: () => void;
}): ReactElement | null {
  const metadata = useProviderMetadata(feature.runtime_provider, null, "mono");
  const asking = liveStatus === "question";
  const badge = (
    <SidebarProviderBadge
      providerId={feature.runtime_provider}
      modelId={feature.model_session}
      thinkingEffort={feature.thinking_effort}
      liveStatus={liveStatus}
      unread={isUnread}
    />
  );

  if (!asking) return badge;

  return (
    <SidebarPendingGatePopover
      featureId={feature.id}
      allowAutoOpen={!isActive}
      onOpenConversation={onOpenConversation}
    >
      {metadata ? badge : undefined}
    </SidebarPendingGatePopover>
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
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {!isArchived && (
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={isPinned}
          className={`size-6 shrink-0 p-0 hover:text-foreground transition-none ${
            isPinned
              ? "text-foreground"
              : "text-muted-foreground opacity-0 group-hover/feature:opacity-100"
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
        className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground opacity-0 group-hover/feature:opacity-100 transition-none"
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
}: {
  shellCount: number;
  browserCount: number;
}): ReactElement | null {
  if (shellCount <= 0 && browserCount <= 0) return null;
  return (
    <span data-feature-activity-indicators className="inline-flex shrink-0 items-center gap-1">
      <FeatureActivityBadge
        count={shellCount}
        labelSingular="shell command running"
        labelPlural="shell commands running"
        icon={<TerminalIcon className="size-3" />}
      />
      <FeatureActivityBadge
        count={browserCount}
        labelSingular="browser tab open"
        labelPlural="browser tabs open"
        icon={<GlobeIcon className="size-3" />}
      />
    </span>
  );
}

function FeatureActivityBadge({
  count,
  labelSingular,
  labelPlural,
  icon,
}: {
  count: number;
  labelSingular: string;
  labelPlural: string;
  icon: ReactElement;
}): ReactElement | null {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? labelSingular : labelPlural}`;
  return (
    <FeatureMetaBadge icon={icon} label={label}>
      <span>{count}</span>
    </FeatureMetaBadge>
  );
}
