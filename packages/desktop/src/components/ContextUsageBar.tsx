import { type ReactElement, useState } from "react";
import {
  normalizeContextWindow,
  totalTokens,
  type ContextUsageState,
  usageRatio as computeUsageRatio,
} from "@/types/agent";
import { cn } from "@/lib/utils";
import { getContextUsageAppearance } from "@/lib/context-usage-appearance";
import { KbdShortcut } from "@/components/KbdShortcut";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ContextUsageBar({
  usage,
  className,
  isStreaming,
}: {
  usage: ContextUsageState | null | undefined;
  className?: string;
  isStreaming: boolean;
}): ReactElement | null {
  const [open, setOpen] = useState(false);

  if (!usage) return null;
  if (normalizeContextWindow(usage.contextWindow) == null) return null;

  const ratio = computeUsageRatio(usage);
  const appearance = getContextUsageAppearance(ratio);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          tabIndex={0}
          className={cn("flex items-center gap-2 px-3 py-1", className)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <div className="h-[3px] flex-1 rounded-full bg-border/80">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
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
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
            {Math.round(ratio * 100)}%
          </span>
          <PromptKeyboardHint />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="pointer-events-none flex w-auto flex-col gap-2 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextUsageDetails usage={usage} />
      </PopoverContent>
    </Popover>
  );
}

function ContextUsageDetails({ usage }: { usage: ContextUsageState }): ReactElement {
  const contextWindow = normalizeContextWindow(usage.contextWindow);
  return (
    <div className="flex flex-col gap-1.5">
      <ContextUsageRow
        label="Tokens used"
        value={`${totalTokens(usage).toLocaleString()} / ${contextWindow?.toLocaleString() ?? "—"}`}
      />
      <ContextUsageRow label="Input" value={usage.inputTokens.toLocaleString()} />
      <ContextUsageRow label="Output" value={usage.outputTokens.toLocaleString()} />
      {usage.wasCompacted ? <ContextUsageRow label="Context compacted" value="Yes" /> : null}
    </div>
  );
}

function ContextUsageRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="rounded bg-muted/60 px-2 py-1 font-mono text-[11px]">{value}</span>
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
