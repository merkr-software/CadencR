import { memo, type ReactElement } from "react";
import { SubagentCardPeek, SubagentCardPeekFrame } from "@/components/subagents/SubagentCardParts";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpawnedSessionActivity } from "@/hooks/useSpawnedSessionActivity";
import { apiErrorMessage } from "@/lib/api-errors";
import { hasCompactLine } from "@/lib/agent-stream-display";
import type { LiveAgentStatus } from "@/types/agent";

/**
 * Under a spawned conversation's card, like a sub-agent's: its latest action,
 * live while it works, then the head of its last reply once it stopped.
 */
export const SpawnedSessionPeek = memo(function SpawnedSessionPeek({
  featureId,
  status,
  basePath,
}: {
  featureId: number;
  status: LiveAgentStatus;
  basePath?: string;
}): ReactElement | null {
  const activity = useSpawnedSessionActivity(featureId, status);
  const working = status === "agent";
  const report = working ? null : activity.reply;
  if (activity.steps.some(hasCompactLine) || report) {
    return <SubagentCardPeek actions={activity.steps} report={report} basePath={basePath} />;
  }
  if (activity.error) {
    return (
      <SubagentCardPeekFrame>
        <p
          className="flex h-6 items-center text-xs text-muted-foreground"
          title={apiErrorMessage(activity.error, "unknown error")}
        >
          Latest activity unavailable
        </p>
      </SubagentCardPeekFrame>
    );
  }
  if (!working || !activity.isLoading) return null;
  return (
    <SubagentCardPeekFrame>
      <div className="flex h-6 items-center" aria-label="Loading latest activity">
        <Skeleton className="h-3 w-40" />
      </div>
    </SubagentCardPeekFrame>
  );
});
