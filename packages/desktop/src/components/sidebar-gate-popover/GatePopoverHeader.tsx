import { useUiTranslation } from "@/lib/i18n/ui";
import { type ReactElement } from "react";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { gateQueuePosition, useGateQueueIds } from "@/hooks/useGateQueue";
import { useGatePopoverSubject } from "@/hooks/useGatePopoverContext";
import { PENDING_KIND_TEXT_CLASS } from "@/components/sidebar-pending-gate";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { useOpenGateQuickReply } from "@/hooks/useOpenGateQuickReply";
import { formatSidebarRelativeTime } from "@/lib/sidebar-time";
import type { PendingKind } from "@/types/agent";
import { cn } from "@/lib/utils";

interface GatePopoverHeaderProps {
  featureId: number;
  kind: PendingKind;
  /** Bigger buttons for the phone's sheet. */
  touch: boolean;
  /** Names the title, for the popover or sheet that is labelled by it. */
  titleId: string;
  onOpenConversation: () => void;
  onClose: () => void;
}

/**
 * The quick reply's own header: who asks (kind, conversation, project, how long
 * it has waited), the queue's arrows when several wait, and the two ways out:
 * open the conversation, or close.
 */
export function GatePopoverHeader({
  featureId,
  kind,
  touch,
  titleId,
  onOpenConversation,
  onClose,
}: GatePopoverHeaderProps): ReactElement {
  const { t } = useUiTranslation();
  const { title, projectName, waitingSinceMs } = useGatePopoverSubject(featureId);
  const isPermission = kind === "permission";
  const Icon = isPermission ? ShieldAlertIcon : MessageCircleQuestionIcon;
  const buttonSize = touch ? "icon" : "icon-xs";
  return (
    <header
      data-gate-popover-header
      className={cn(
        "flex items-start gap-2 border-b border-border/60 px-3 py-2.5",
        touch && "px-4",
      )}
    >
      <Icon
        role="img"
        aria-label={
          isPermission
            ? t("sidebar.gatePopoverHeader.permissionNeeded", "Permission needed")
            : t("sidebar.gatePopoverHeader.question", "Question")
        }
        className={cn("mt-0.5 size-4 shrink-0", PENDING_KIND_TEXT_CLASS[kind])}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          id={titleId}
          className="truncate text-xs font-medium text-foreground"
          title={title ?? undefined}
        >
          {title ?? t("sidebar.gatePopoverHeader.conversation", "Conversation")}
        </span>
        <span className="flex min-w-0 gap-1 text-[11px] leading-4 text-muted-foreground">
          {/* The icon names the kind: the line keeps its width for where and since when. */}
          {projectName ? <span className="truncate">{projectName}</span> : null}
          {waitingSinceMs != null ? (
            <WaitingAge sinceMs={waitingSinceMs} separated={Boolean(projectName)} />
          ) : null}
        </span>
      </div>
      <GateQueueNavigation featureId={featureId} buttonSize={buttonSize} />
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          aria-label={t("sidebar.gatePopoverHeader.openConversation", "Open conversation")}
          title={t("sidebar.gatePopoverHeader.openConversation", "Open conversation")}
          onClick={onOpenConversation}
        >
          <ArrowUpRightIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          aria-label={t("sidebar.gatePopoverHeader.close", "Close")}
          title={t("sidebar.gatePopoverHeader.close", "Close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
    </header>
  );
}

/** The arrows switch the quick reply to another waiting conversation. */
function GateQueueNavigation({
  featureId,
  buttonSize,
}: {
  featureId: number;
  buttonSize: "icon" | "icon-xs";
}): ReactElement | null {
  const { t } = useUiTranslation();
  const onSelectFeature = useOpenGateQuickReply();
  const queue = gateQueuePosition(useGateQueueIds(), featureId);
  if (queue.total <= 1 || queue.position <= 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
      <Button
        type="button"
        variant="ghost"
        size={buttonSize}
        aria-label={t("sidebar.gatePopoverHeader.previousRequest", "Previous request")}
        title={t("sidebar.gatePopoverHeader.previousRequest", "Previous request")}
        disabled={queue.previousId == null}
        onClick={() => queue.previousId != null && onSelectFeature(queue.previousId)}
      >
        <ChevronLeftIcon />
      </Button>
      <span aria-live="polite">
        {t("sidebar.gatePopoverHeader.queuePosition", "{{position}} of {{total}}", {
          position: queue.position,
          total: queue.total,
        })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size={buttonSize}
        aria-label={t("sidebar.gatePopoverHeader.nextRequest", "Next request")}
        title={t("sidebar.gatePopoverHeader.nextRequest", "Next request")}
        disabled={queue.nextId == null}
        onClick={() => queue.nextId != null && onSelectFeature(queue.nextId)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

function WaitingAge({ sinceMs, separated }: { sinceMs: number; separated: boolean }): ReactElement {
  const { t } = useUiTranslation();
  const now = useMinuteClock();
  return (
    <time
      dateTime={new Date(sinceMs).toISOString()}
      className="shrink-0"
      title={t(
        "sidebar.gatePopoverHeader.howLongTheAgentHasWaited",
        "How long the agent has waited for you",
      )}
    >
      {separated ? "· " : ""}
      {formatSidebarRelativeTime(new Date(sinceMs), now)}
    </time>
  );
}
