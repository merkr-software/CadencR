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
  // The queue's arrows switch the quick reply to another waiting conversation.
  const onSelectFeature = useOpenGateQuickReply();
  const { title, projectName, waitingSinceMs } = useGatePopoverSubject(featureId);
  const queue = gateQueuePosition(useGateQueueIds(), featureId);
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
        aria-label={isPermission ? "Permission needed" : "Question"}
        className={cn("mt-0.5 size-4 shrink-0", PENDING_KIND_TEXT_CLASS[kind])}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          id={titleId}
          className="truncate text-xs font-medium text-foreground"
          title={title ?? undefined}
        >
          {title ?? "Conversation"}
        </span>
        <span className="flex min-w-0 gap-1 text-[11px] leading-4 text-muted-foreground">
          {/* The icon names the kind: the line keeps its width for where and since when. */}
          {projectName ? <span className="truncate">{projectName}</span> : null}
          {waitingSinceMs != null ? (
            <WaitingAge sinceMs={waitingSinceMs} separated={Boolean(projectName)} />
          ) : null}
        </span>
      </div>
      {queue.total > 1 && queue.position > 0 ? (
        <div className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size={buttonSize}
            aria-label="Previous request"
            title="Previous request"
            disabled={queue.previousId == null}
            onClick={() => queue.previousId != null && onSelectFeature(queue.previousId)}
          >
            <ChevronLeftIcon />
          </Button>
          <span aria-live="polite">
            {queue.position} of {queue.total}
          </span>
          <Button
            type="button"
            variant="ghost"
            size={buttonSize}
            aria-label="Next request"
            title="Next request"
            disabled={queue.nextId == null}
            onClick={() => queue.nextId != null && onSelectFeature(queue.nextId)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          aria-label="Open conversation"
          title="Open conversation"
          onClick={onOpenConversation}
        >
          <ArrowUpRightIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
    </header>
  );
}

function WaitingAge({ sinceMs, separated }: { sinceMs: number; separated: boolean }): ReactElement {
  const now = useMinuteClock();
  return (
    <time
      dateTime={new Date(sinceMs).toISOString()}
      className="shrink-0"
      title="How long the agent has waited for you"
    >
      {separated ? "· " : ""}
      {formatSidebarRelativeTime(new Date(sinceMs), now)}
    </time>
  );
}
