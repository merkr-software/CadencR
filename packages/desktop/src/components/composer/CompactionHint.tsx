import { memo, useState, type ReactElement } from "react";
import { Layers, X } from "lucide-react";
import { useGetFeature } from "@/api/generated";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { totalTokens, usageRatio, type ContextUsageState } from "@/types/agent";
import { useComposerContext } from "./ComposerContext";

/** A conversation older than this, carrying a large context, is worth compacting. */
const COMPACTION_MIN_AGE_MS = 60 * 60 * 1000;
/** "Large": half the window, or 100k tokens when the window is unknown. */
const COMPACTION_MIN_RATIO = 0.5;
const COMPACTION_MIN_TOKENS = 100_000;

export function shouldRecommendCompaction(
  usage: ContextUsageState | null,
  conversationStartedAt: string | undefined,
  now: number,
): boolean {
  if (!usage || !conversationStartedAt) return false;
  const started = Date.parse(conversationStartedAt);
  if (Number.isNaN(started) || now - started < COMPACTION_MIN_AGE_MS) return false;
  const ratio = usageRatio(usage);
  return ratio != null
    ? ratio >= COMPACTION_MIN_RATIO
    : totalTokens(usage) >= COMPACTION_MIN_TOKENS;
}

/**
 * Suggests compacting a long-lived conversation whose context has grown
 * large — every turn re-reads that context, so it gets slower and costlier.
 * Only offered when the provider has a `/compact` command; dismissible for the
 * rest of the session.
 */
export const CompactionHint = memo(function CompactionHint(): ReactElement | null {
  const { featureId, contextUsage, slashCommands, isRunning, send } = useComposerContext();
  const [dismissed, setDismissed] = useState(false);
  // Ticks each minute, so the hint appears once the hour passes, unprompted.
  const now = useMinuteClock();
  const { data: feature } = useGetFeature(featureId ?? 0, {
    query: { enabled: featureId != null },
  });
  const canCompact = !!slashCommands?.some((command) => command.name === "compact");
  if (
    dismissed ||
    isRunning ||
    !canCompact ||
    !shouldRecommendCompaction(contextUsage, feature?.created_at, now)
  ) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--acc-orange)]/10 text-[var(--acc-orange)]">
      <button
        type="button"
        onClick={() => send("/compact")}
        title="This conversation is over an hour old and its context is large: compacting keeps a summary and makes each turn faster and cheaper."
        className="composer-instrument gap-1.5"
      >
        <Layers className="size-3.5" aria-hidden />
        <span className="@max-[34rem]:hidden">Compact</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss the compaction suggestion"
        onClick={() => setDismissed(true)}
        className="flex size-6 items-center justify-center rounded-md hover:bg-[var(--acc-orange)]/15"
      >
        <X className="size-3" />
      </button>
    </span>
  );
});
