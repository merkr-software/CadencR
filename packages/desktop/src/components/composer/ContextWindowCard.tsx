import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { History, MousePointerClick } from "lucide-react";
import { contextMeterDisplayLabel, type ContextMeterDisplay } from "@/lib/context-meter-display";
import { getContextUsageAppearance } from "@/lib/context-usage-appearance";
import { cn } from "@/lib/utils";
import { totalTokens, type ContextUsageState } from "@/types/agent";
import { formatCompactTokens } from "@/components/usage/usage-chart-palette";

/** Cells of the segmented gauge; each one is 5% of the window. */
const CELLS = 20;

/**
 * The context meter's hover card: how much of the model's window this
 * conversation fills, in one glance — a big percentage in the gauge's tone, a
 * segmented gauge, then used / free / window in plain numbers. With a
 * `display`, it also says how the meter reads and that a click changes it.
 */
export function ContextWindowCard({
  usage,
  ratio,
  display,
}: {
  usage: ContextUsageState;
  ratio: number | null;
  display?: ContextMeterDisplay;
}): ReactElement {
  const { t } = useUiTranslation();
  const used = totalTokens(usage);
  if (ratio == null || !usage.contextWindow) {
    return (
      <div className="flex w-56 flex-col gap-1 p-3">
        <CardTitle />
        <p className="text-[20px] leading-7 font-semibold tabular-nums">
          {formatCompactTokens(used)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {t("conversation.composer.contextWindowCard.tokensUsed", "tokens used")}
          </span>
        </p>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t(
            "conversation.composer.contextWindowCard.theProviderReportsTheWindowSizeAt",
            "The provider reports the window size at the end of a turn.",
          )}
        </p>
        <CompactedNote usage={usage} />
        <DisplayHint display={display} />
      </div>
    );
  }
  const { glowColor: tone, verdict } = getContextUsageAppearance(ratio, t);
  const filled = Math.min(CELLS, Math.round(ratio * CELLS));
  const free = Math.max(0, usage.contextWindow - used);
  return (
    <div className="flex w-60 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between">
        <CardTitle />
        <span className="text-[20px] leading-7 font-semibold tabular-nums" style={{ color: tone }}>
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div aria-hidden className="grid grid-cols-[repeat(20,1fr)] gap-[2px]">
        {Array.from({ length: CELLS }, (_, cell) => (
          <span
            key={cell}
            className={cn("h-1.5 rounded-[1px]", cell >= filled && "bg-border")}
            style={cell < filled ? { backgroundColor: tone } : undefined}
          />
        ))}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[11px] leading-4">
        <Figure
          label={t("conversation.composer.contextWindowCard.used", "Used")}
          value={formatCompactTokens(used)}
        />
        <Figure
          label={t("conversation.composer.contextWindowCard.free", "Free")}
          value={formatCompactTokens(free)}
        />
        <Figure
          label={t("conversation.composer.contextWindowCard.window", "Window")}
          value={formatCompactTokens(usage.contextWindow)}
        />
      </dl>
      <p className="text-[11px] leading-4 text-muted-foreground">{verdict}</p>
      <CompactedNote usage={usage} />
      <DisplayHint display={display} />
    </div>
  );
}

function DisplayHint({ display }: { display?: ContextMeterDisplay }): ReactElement | null {
  const { t } = useUiTranslation();
  if (!display) return null;
  return (
    <p className="flex items-center gap-1.5 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
      <span className="truncate text-foreground/80">{contextMeterDisplayLabel(t, display)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <MousePointerClick className="size-3" />
        {t("conversation.composer.contextWindowCard.clickToChange", "click to change")}
      </span>
    </p>
  );
}

function CardTitle(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <span className="text-xs font-medium text-foreground">
      {t("conversation.composer.contextWindowCard.contextWindow", "Context window")}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function CompactedNote({ usage }: { usage: ContextUsageState }): ReactElement | null {
  const { t } = useUiTranslation();
  if (!usage.wasCompacted) return null;
  return (
    <p className="flex items-center gap-1.5 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
      <History className="size-3 shrink-0 text-[var(--acc-orange)]" />
      {t(
        "conversation.composer.contextWindowCard.compacted",
        "Compacted earlier in this conversation",
      )}
    </p>
  );
}
