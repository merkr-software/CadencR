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
import { formatExactWords } from "./usage-chart-palette";

/**
 * Shown when the backend reports that at least one usage write failed.
 *
 * Usage recording is fire-and-forget so a counter can never fail an agent turn,
 * but a failure still has to reach the user: without this the charts would just
 * quietly under-report and look authoritative while doing it.
 *
 * Dismissible, because a write lost at shutdown is counted from what was still
 * in flight when the process went away — an estimate that can overstate the
 * damage. A warning the user cannot answer would otherwise mark the stats
 * incomplete forever. Anything that fails afterwards raises it again.
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
        toast.error("Could not dismiss the usage recording warning", {
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
          {/* "recording", not "writes": the counter also covers the one-time
              import of older conversations, not just live turns. */}
          {issue.failures === 1
            ? "A usage recording error occurred, so these totals may be incomplete."
            : `${formatExactWords(issue.failures)} usage recording errors occurred, so these totals may be incomplete.`}
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
