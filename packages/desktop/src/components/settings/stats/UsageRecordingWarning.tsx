import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUsageStatsQueryKey,
  useDismissUsageRecordingIssue,
  type UsageRecordingIssue,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WARNING_BANNER_CLASS } from "@/components/settings/SettingsWarningsBanner";
import { formatExactNumber } from "./usage-chart-palette";

/**
 * Shown when the backend reports that at least one usage data operation failed.
 *
 * Usage writes are awaited to preserve provider event order, but a stats
 * failure must never fail an agent turn. Without this warning the charts would
 * quietly under-report and still look authoritative. Anything that fails after
 * dismissal raises the warning again.
 */
export function UsageRecordingWarning({
  issue,
}: {
  issue: UsageRecordingIssue | null | undefined;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const { mutate: dismiss, isPending } = useDismissUsageRecordingIssue({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetUsageStatsQueryKey() });
      },
      onError: (error) => {
        toast.error("Could not dismiss the usage data warning", {
          description: apiErrorMessage(error, "The service did not accept the request."),
        });
      },
    },
  });

  if (!issue) return null;

  return (
    <div role="status" className={cn(WARNING_BANNER_CLASS, "flex items-start gap-2")}>
      <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0 text-[var(--acc-orange)]" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs text-foreground">
          {issue.failures === 1
            ? "A usage data error occurred, so these totals may be incomplete."
            : `${formatExactNumber(issue.failures)} usage data errors occurred, so these totals may be incomplete.`}
        </p>
        <p className="break-words text-[11px] text-muted-foreground">{issue.last_error}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-[11px]"
        disabled={isPending}
        onClick={() => dismiss()}
      >
        {isPending ? <Loader2 aria-hidden className="size-3 animate-spin" /> : null}
        Dismiss
      </Button>
    </div>
  );
}
