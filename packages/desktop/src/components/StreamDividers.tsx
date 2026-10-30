/**
 * Visual dividers in the agent stream marking compaction and clear events.
 *
 * Extracted from `AgentBlock.tsx` purely to keep that file under the
 * 400-line cap; the components are agent-stream-specific and not meant
 * for reuse outside of stream rendering.
 */
import { cn } from "@/lib/utils";

interface CompactMetadata {
  trigger?: string;
  pre_tokens?: number;
}

function parseCompactMetadata(raw: string): CompactMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const trigger = typeof record.trigger === "string" ? record.trigger : undefined;
    const pre = typeof record.pre_tokens === "number" ? record.pre_tokens : undefined;
    if (trigger === undefined && pre === undefined) return null;
    return { trigger, pre_tokens: pre };
  } catch {
    return null;
  }
}

function formatCompactSummary(metadata: CompactMetadata): string {
  const bits: string[] = [];
  if (metadata.trigger) bits.push(metadata.trigger);
  if (typeof metadata.pre_tokens === "number" && metadata.pre_tokens > 0) {
    bits.push(`${metadata.pre_tokens.toLocaleString()} tokens`);
  }
  return bits.join(" · ");
}

function StreamDivider({
  label,
  tone,
  detail,
}: {
  label: string;
  tone: "yellow" | "cyan";
  detail?: string;
}) {
  const line = tone === "yellow" ? "bg-yellow-500/30" : "bg-cyan-500/30";
  const text = tone === "yellow" ? "text-yellow-500" : "text-cyan-500";
  return (
    <div className="flex flex-col items-center gap-1 py-3">
      {detail && <span className="text-[10px] text-muted-foreground/50 font-mono">{detail}</span>}
      <div className="flex w-full items-center gap-3">
        <div className={cn("h-px flex-1", line)} />
        <span className={cn("text-xs font-medium", text)}>{label}</span>
        <div className={cn("h-px flex-1", line)} />
      </div>
    </div>
  );
}

export function CompactDivider({ metadata }: { metadata?: string }) {
  const parsed = metadata ? parseCompactMetadata(metadata) : null;
  const detail = parsed ? formatCompactSummary(parsed) : undefined;
  return <StreamDivider label="Compacted" tone="yellow" detail={detail} />;
}

export function ClearDivider({ previousSessionId }: { previousSessionId?: string }) {
  return <StreamDivider label="Cleared" tone="cyan" detail={previousSessionId || undefined} />;
}

export function TurnSummaryDivider({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
      <span className="h-0.5 w-5 shrink-0 rounded-full bg-muted-foreground/65" />
      <span className="font-medium tabular-nums">{content}</span>
    </div>
  );
}
