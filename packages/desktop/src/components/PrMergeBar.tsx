import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CircleDashedIcon,
  ClockIcon,
  GitMergeIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useDeletePrMerge,
  type MergeAction,
  type PrMergeStatus,
  type PrSummary,
} from "@/api/generated";
import { PrMergeDialog } from "@/components/PrMergeDialog";
import { PR_ICON_STYLE, type PrIndicatorTone } from "@/components/PrStatusIndicators";
import { TONE_TEXT } from "@/components/PrStatusBandChecks";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  cancelLabel,
  mergeActionLabel,
  mergeHeadline,
  noActionExplanation,
  readinessTone,
} from "@/lib/pr-merge";
import { cn } from "@/lib/utils";

export interface PrMergeBarProps {
  featureId: number;
  pr: PrSummary;
  status: PrMergeStatus | undefined;
  isLoading: boolean;
  error: string | null;
  onRefetch: () => void;
}

/**
 * The band's last row: can this land, and the button that lands it.
 *
 * Every action goes through the forge and comes back through it — nothing here
 * flips to "merged" on click. The dialog confirms; the forge's answer, then the
 * next status read, is what the row shows.
 */
export function PrMergeBar({
  featureId,
  pr,
  status,
  isLoading,
  error,
  onRefetch,
}: PrMergeBarProps): ReactElement | null {
  const [dialogAction, setDialogAction] = useState<MergeAction | null>(null);

  if (!status) {
    if (isLoading) {
      return (
        <Row>
          <Loader2Icon
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
          <span className="text-[12px] text-muted-foreground">Checking merge status…</span>
        </Row>
      );
    }
    if (!error) return null;
    return (
      <Row>
        <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] text-destructive" title={error}>
          {error}
        </span>
        <RetryButton onRetry={onRefetch} />
      </Row>
    );
  }

  const tone = readinessTone(status);
  const primary = status.actions[0];
  const permission = noActionExplanation(status);
  const detail = [...status.reasons, ...(permission ? [permission] : [])].join(" · ");
  return (
    <Row>
      <span className={cn("inline-flex shrink-0", PR_ICON_STYLE[tone])}>
        <ReadinessIcon status={status} />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn("shrink-0 text-[12px] font-medium", headlineClass(tone))}>
          {mergeHeadline(status)}
        </span>
        {detail && (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground" title={detail}>
            {detail}
          </span>
        )}
      </div>
      {error && (
        // The row above is the last status that loaded; say it may be stale.
        <span className="inline-flex shrink-0 items-center gap-0.5 text-destructive" title={error}>
          <AlertCircleIcon
            className="size-3.5"
            aria-label={`Merge status may be out of date: ${error}`}
          />
          <RetryButton onRetry={onRefetch} />
        </span>
      )}
      {status.cancellable && (
        <CancelButton featureId={featureId} status={status} onDone={onRefetch} />
      )}
      {primary && (
        <Button size="xs" className="shrink-0" onClick={() => setDialogAction(primary)}>
          <GitMergeIcon aria-hidden />
          {mergeActionLabel(primary, status)}
        </Button>
      )}
      {dialogAction && (
        <PrMergeDialog
          featureId={featureId}
          pr={pr}
          status={status}
          action={dialogAction}
          open
          onOpenChange={(open) => {
            if (!open) setDialogAction(null);
          }}
          onDone={onRefetch}
        />
      )}
    </Row>
  );
}

function Row({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="flex min-h-9 items-center gap-2 border-t border-border/70 px-4 py-1.5">
      {children}
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onRetry}
      aria-label="Retry merge status"
      title="Retry merge status"
    >
      <RefreshCwIcon aria-hidden />
    </Button>
  );
}

function headlineClass(tone: PrIndicatorTone): string {
  return tone === "neutral" ? "text-foreground" : TONE_TEXT[tone];
}

function ReadinessIcon({ status }: { status: PrMergeStatus }): ReactElement {
  const className = "size-3.5 shrink-0";
  if (status.queue_entry || status.auto_merge) {
    return <ClockIcon className={className} aria-hidden />;
  }
  switch (status.readiness) {
    case "ready":
      return <GitMergeIcon className={className} aria-hidden />;
    case "checking":
      return <Loader2Icon className={cn(className, "animate-spin")} aria-hidden />;
    case "blocked":
    case "behind":
    case "conflicts":
      return <AlertTriangleIcon className={className} aria-hidden />;
    case "draft":
    case "closed":
      return <CircleDashedIcon className={className} aria-hidden />;
  }
}

function CancelButton({
  featureId,
  status,
  onDone,
}: {
  featureId: number;
  status: PrMergeStatus;
  onDone: () => void;
}): ReactElement {
  const cancel = useDeletePrMerge();
  const label = cancelLabel(status);
  const handle = async (): Promise<void> => {
    try {
      await cancel.mutateAsync({
        params: { feature_id: featureId, pr_number: status.pr_number },
      });
      toast.success(
        status.queue_entry ? `#${status.pr_number} left the queue` : "Auto-merge cancelled",
      );
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, `Could not ${label.toLowerCase()}`));
    }
  };
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0"
      disabled={cancel.isPending}
      onClick={() => void handle()}
    >
      {cancel.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
      {label}
    </Button>
  );
}
