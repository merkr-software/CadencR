import { memo, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { useStreamingMarkdownThrottle } from "@/hooks/useStreamingMarkdownThrottle";

/** First non-empty line of the reasoning, stripped of leading markdown markers
 * and bold marks (reasoning often opens on a `**Heading**`), used as a one-line
 * preview next to the "Thinking" label when collapsed. Matches only up to the
 * first newline so the cost stays constant regardless of how long the
 * accumulated reasoning grows. */
export function thinkingPreview(content: string): string {
  const firstLine = /^[^\n]*\S[^\n]*/m.exec(content)?.[0] ?? "";
  return firstLine
    .trim()
    .replace(/^(?:#+|[-*>]|\d+\.)\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1");
}

interface ThinkingBlockProps {
  content: string;
  cacheKey?: string;
  isStreaming?: boolean;
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
  disableCache?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  cacheKey,
  isStreaming,
  expanded,
  onExpandedChange,
  disableCache,
}: ThinkingBlockProps): ReactElement | null {
  const [internalExpanded, setInternalExpanded] = useState(true);
  const isExpanded = expanded ?? internalExpanded;
  // Throttle re-parse of the actively streaming thinking block (see hook).
  const displayContent = useStreamingMarkdownThrottle(content, !!isStreaming);
  // Only the collapsed header shows the preview, and it reads from the same
  // throttled string as the body — so streaming reasoning doesn't recompute it
  // on every raw token.
  const preview = useMemo(
    () => (isExpanded ? "" : thinkingPreview(displayContent)),
    [isExpanded, displayContent],
  );
  if (!content.trim()) return null;

  const toggleExpanded = () => {
    const next = !isExpanded;
    onExpandedChange?.(next);
    if (expanded === undefined) setInternalExpanded(next);
  };

  // The agent's internal monologue. Surface + accent come from the theme's
  // `--block-thinking-*` tokens; the outline is themable via
  // `--block-thinking-border` (a whisper of the thinking accent in the CadencR
  // pair) and falls back to the neutral `--border` everywhere else.
  return (
    <div className="my-1 rounded-md border border-[var(--block-thinking-border,var(--border))] bg-[var(--block-thinking-bg)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={toggleExpanded}
      >
        <BrainIcon className="size-3 shrink-0 text-[var(--block-thinking-accent)]" />
        <span
          className={cn(
            "shrink-0 font-medium text-[var(--block-thinking-accent)]",
            // Glow while reasoning tokens stream in — regardless of collapse
            // state or whether this block lives inside a subagent panel.
            isStreaming && "thinking-glow",
          )}
        >
          Thinking
        </span>
        {!isExpanded && preview && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={preview}>
            {preview}
          </span>
        )}
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      </button>
      <CollapsibleSection open={isExpanded}>
        <div className="border-t border-[var(--block-thinking-border,var(--border))] px-3 py-2">
          <Markdown
            content={displayContent}
            cacheKey={cacheKey}
            isStreaming={isStreaming}
            className="text-xs text-muted-foreground"
            disableCache={disableCache}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
});
