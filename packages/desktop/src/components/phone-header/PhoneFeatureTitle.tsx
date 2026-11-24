import type { ReactElement } from "react";

import { FeatureTitleMenu } from "@/components/FeatureTitleMenu";
import { ProjectBadge } from "@/components/ProjectBadge";
import { STATUS_LABELS } from "@/components/StatusShape";
import { Skeleton } from "@/components/ui/skeleton";
import { ATTENTION_LABEL } from "@/lib/sidebar-attention";
import { useFeatureStatus } from "@/stores/session-status-selectors";

export interface PhoneFeatureTitleProps {
  featureId: number;
  projectId: number;
  featureTitle: string;
  isAutoNaming: boolean;
  canAutoRename: boolean;
  isAutoRenamePending: boolean;
  onAutoRename: () => void;
}

/**
 * The phone header's leading part (the header is `FeatureTopBar`'s, shared
 * with the desktop layout): a status dot and the title, the same rename/copy
 * menu as on desktop. "…" after it holds the rest (`PhoneFeatureMoreSheet`).
 */
export function PhoneFeatureTitle({
  featureId,
  projectId,
  featureTitle,
  isAutoNaming,
  canAutoRename,
  isAutoRenamePending,
  onAutoRename,
}: PhoneFeatureTitleProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <PhoneStatusDot featureId={featureId} projectId={projectId} />
      {isAutoNaming ? (
        <Skeleton className="h-5 w-32" />
      ) : (
        <FeatureTitleMenu
          featureId={featureId}
          title={featureTitle}
          canAutoRename={canAutoRename}
          isAutoRenamePending={isAutoRenamePending}
          onAutoRename={onAutoRename}
          className="text-base"
        />
      )}
    </div>
  );
}

/**
 * The agent's state where the project badge sits: working (breathing blue)
 * or waiting on you (amber); idle shows the project's badge.
 */
function PhoneStatusDot({
  featureId,
  projectId,
}: {
  featureId: number;
  projectId: number;
}): ReactElement {
  const { status } = useFeatureStatus(featureId);
  if (status === "agent") {
    return (
      <span
        role="img"
        aria-label={STATUS_LABELS.working.label}
        className="sidebar-status-dot-working size-2.5 shrink-0 rounded-full bg-blue-500"
      />
    );
  }
  if (status === "question") {
    return (
      <span
        role="img"
        aria-label={ATTENTION_LABEL.waiting}
        className="size-2.5 shrink-0 rounded-full bg-(--acc-yellow)"
      />
    );
  }
  return <ProjectBadge projectId={projectId} size="md" />;
}
