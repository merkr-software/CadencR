import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { ArchiveIcon, MessageCircleQuestionIcon, ShieldAlertIcon } from "lucide-react";
import { StatusShape } from "@/components/StatusShape";
import { PENDING_KIND_TEXT_CLASS, triggerPendingKind } from "@/components/sidebar-pending-gate";
import type { AttentionState } from "@/lib/sidebar-attention";
import { cn } from "@/lib/utils";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import type { PendingKind } from "@/types/agent";

/** What a waiting conversation asks, from its live status (no request lookup). */
export function usePendingKind(featureId: number): PendingKind {
  return triggerPendingKind(useFeatureStatus(featureId).kind, null);
}

/**
 * A conversation's status glyph outside the sidebar rows (command palette,
 * phone inbox): the sidebar's shapes, an archived conversation's box, and a
 * pending request's shield or question in its kind's color.
 */
export function ConversationStatus({
  featureId,
  state,
  archived,
  className = "size-3.5",
}: {
  featureId: number;
  state: AttentionState;
  archived: boolean;
  /** The waiting glyph's size (and extra classes). */
  className?: string;
}): ReactElement {
  const { t } = useUiTranslation();
  if (archived && state === "idle") {
    return (
      <ArchiveIcon
        aria-label={t("palette.status.archived", "Archived")}
        className="size-3 text-muted-foreground"
      />
    );
  }
  if (state === "waiting") return <WaitingGlyph featureId={featureId} className={className} />;
  return <StatusShape state={state} />;
}

function WaitingGlyph({
  featureId,
  className,
}: {
  featureId: number;
  className: string;
}): ReactElement {
  const { t } = useUiTranslation();
  const kind = usePendingKind(featureId);
  const classes = cn(className, PENDING_KIND_TEXT_CLASS[kind]);
  return kind === "question" ? (
    <MessageCircleQuestionIcon
      aria-label={t("palette.status.question", "Asks a question")}
      className={classes}
    />
  ) : (
    <ShieldAlertIcon
      aria-label={t("palette.status.permission", "Asks for permission")}
      className={classes}
    />
  );
}
