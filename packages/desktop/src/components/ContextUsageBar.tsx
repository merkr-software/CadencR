import { memo, type ReactElement, useState } from "react";
import { contextUsageToShow, totalTokens, usageRatio, type ContextUsageState } from "@/types/agent";
import { cn } from "@/lib/utils";
import {
  getContextUsageAppearance,
  type ContextUsageAppearance,
} from "@/lib/context-usage-appearance";
import { KbdShortcut } from "@/components/KbdShortcut";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCompactTokens } from "@/components/usage/usage-chart-palette";

export function ContextUsageBar({
  usage,
  className,
  isStreaming,
}: {
  usage: ContextUsageState | null | undefined;
  className?: string;
  isStreaming: boolean;
}): ReactElement | null {
  const shown = contextUsageToShow(usage, isStreaming);
  if (!shown) return null;
  return <ContextUsageTrigger usage={shown} className={className} isStreaming={isStreaming} />;
}

function ContextUsageTrigger({
  usage,
  className,
  isStreaming,
}: {
  usage: ContextUsageState;
  className?: string;
  isStreaming: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const used = totalTokens(usage);
  const usedFormatted = used.toLocaleString();
  const ratio = usageRatio(usage);
  const percent = ratio == null ? null : Math.round(ratio * 100);
  const ariaLabel =
    percent == null
      ? `Context usage: ${usedFormatted} tokens, window size not reported yet`
      : `Context usage ${percent}%: ${usedFormatted} of ${usage.contextWindow?.toLocaleString()} tokens`;

  return (
    <div className={cn("flex items-center gap-2 px-3 py-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "flex min-w-0 flex-1 cursor-help items-center gap-2 rounded-sm",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            <UsageMeter ratio={ratio} isStreaming={isStreaming} />
            <span className="shrink-0 text-[10.5px] font-medium tabular-nums text-muted-foreground">
              {percent != null ? `${percent}%` : used > 0 ? formatCompactTokens(used) : "—"}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="pointer-events-none w-auto min-w-[160px] p-3"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextUsageDetails usage={usage} ratio={ratio} />
        </PopoverContent>
      </Popover>
      <PromptKeyboardHint />
    </div>
  );
}

/** A measured window fills the track; an unknown one gets the pending meter. */
function UsageMeter({
  ratio,
  isStreaming,
  className,
}: {
  ratio: number | null;
  isStreaming: boolean;
  className?: string;
}): ReactElement {
  return ratio == null ? (
    <PendingContextMeter isStreaming={isStreaming} className={className} />
  ) : (
    <ContextUsageMeter
      ratio={ratio}
      appearance={getContextUsageAppearance(ratio)}
      isStreaming={isStreaming}
      className={className}
    />
  );
}

const ContextUsageMeter = memo(function ContextUsageMeter({
  ratio,
  appearance,
  isStreaming,
  className,
}: {
  ratio: number;
  appearance: ContextUsageAppearance;
  isStreaming: boolean;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("h-[3px] flex-1 rounded-full bg-border/80", className)}>
      <div
        className={cn(
          "h-full rounded-full transition-[width,box-shadow] duration-150 ease-out",
          isStreaming ? "context-usage-glow" : appearance.barClassName,
        )}
        data-context-usage-style="glow"
        style={{
          width: `${ratio * 100}%`,
          backgroundColor: appearance.glowColor,
          boxShadow: isStreaming
            ? `0 0 4px ${appearance.glowColor}, 0 0 10px color-mix(in srgb, ${appearance.glowColor} 75%, transparent), 0 0 16px color-mix(in srgb, ${appearance.glowColor} 45%, transparent)`
            : "none",
        }}
      />
    </div>
  );
});

/**
 * No provider has reported the window size yet. A soft sweep says "measuring"
 * while the agent works; idle, the empty track stays still rather than
 * implying progress that is not happening.
 */
function PendingContextMeter({
  isStreaming,
  className,
}: {
  isStreaming: boolean;
  className?: string;
}): ReactElement {
  return (
    <div
      className={cn("relative h-[3px] flex-1 overflow-hidden rounded-full bg-border/80", className)}
      data-context-usage-style="pending"
    >
      {isStreaming ? (
        <div className="context-usage-pending absolute inset-y-0 left-0 w-[30%] rounded-full" />
      ) : null}
    </div>
  );
}

function ContextUsageDetails({
  usage,
  ratio,
}: {
  usage: ContextUsageState;
  ratio: number | null;
}): ReactElement {
  const windowLabel = ratio == null ? "—" : usage.contextWindow?.toLocaleString();
  const usedLabel = `${totalTokens(usage).toLocaleString()} / ${windowLabel}`;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-foreground">Context</span>
      <UsageMeter ratio={ratio} isStreaming={false} className="h-1" />
      <p className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{usedLabel}</p>
      {ratio == null ? (
        <p className="text-[10.5px] text-muted-foreground">Window size not reported yet</p>
      ) : null}
      {usage.wasCompacted ? (
        <p className="border-t border-border pt-2 text-[10.5px] font-medium text-[var(--acc-orange)]">
          Context compacted
        </p>
      ) : null}
    </div>
  );
}

function PromptKeyboardHint(): ReactElement {
  return (
    <span className="hidden shrink-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground md:inline-flex">
      <KbdShortcut keys={["enter"]} variant="hint" />
      <span>send</span>
      <span className="text-muted-foreground">·</span>
      <KbdShortcut keys={["shift", "enter"]} variant="hint" />
      <span>newline</span>
    </span>
  );
}
