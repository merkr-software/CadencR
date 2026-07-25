import { AlertTriangle } from "lucide-react";
import type { UsageRecordingIssue } from "@/api/generated";
import { cn } from "@/lib/utils";
import { WARNING_BANNER_CLASS } from "@/components/settings/SettingsWarningsBanner";
import { formatExactWords } from "./usage-chart-palette";

/**
 * Shown when the backend reports that at least one usage write failed.
 *
 * Usage recording is fire-and-forget so a counter can never fail an agent turn,
 * but a failure still has to reach the user: without this the charts would just
 * quietly under-report and look authoritative while doing it.
 */
export function UsageRecordingWarning({
  issue,
}: {
  issue: UsageRecordingIssue | null | undefined;
}): React.JSX.Element | null {
  if (!issue) return null;

  return (
    <div role="status" className={cn(WARNING_BANNER_CLASS, "flex items-start gap-2")}>
      <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0 text-[var(--acc-orange)]" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs text-foreground">
          {/* "recording", not "writes": the counter also covers the one-time
              import of older conversations, not just live turns. */}
          {issue.failures === 1
            ? "A usage recording error occurred, so these totals may be incomplete."
            : `${formatExactWords(issue.failures)} usage recording errors occurred, so these totals may be incomplete.`}
        </p>
        <p className="break-words text-[11px] text-muted-foreground">{issue.last_error}</p>
      </div>
    </div>
  );
}
