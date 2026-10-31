/**
 * Visual dividers in the agent stream marking compaction and clear events.
 *
 * Extracted from `AgentBlock.tsx` purely to keep that file under the
 * 400-line cap; the components are agent-stream-specific and not meant
 * for reuse outside of stream rendering.
 */
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { formatStreamTimestamp } from "@/lib/date-utils";
import type { ModelSwitch, TurnFooter } from "@/lib/agent-turn-annotations";

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

/** Gaps around a turn's closing line, live summary row or not. */
export const TURN_CLOSING_SPACING = "pt-2 pb-0.5";

/**
 * A finished turn's closing line: the live timing ("Worked - 21s · …") when
 * this device watched the turn end, then the model(s) that wrote it and when
 * it ended — said once per turn instead of over every reply.
 */
export function TurnSummaryDivider({ content, footer }: { content?: string; footer?: TurnFooter }) {
  const models = footer?.models.join(" → ");
  const endedAt = footer?.endedAt ? formatStreamTimestamp(footer.endedAt) : undefined;
  const details = [
    models && (
      <span key="models" className="font-mono text-[11px]">
        {models}
      </span>
    ),
    endedAt && <span key="ended">{endedAt}</span>,
  ].filter(Boolean);
  return (
    <div data-turn-footer className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="h-0.5 w-5 shrink-0 rounded-full bg-muted-foreground/65" aria-hidden />
      <span className="min-w-0 truncate tabular-nums">
        {content && <span className="font-medium">{content}</span>}
        {details.length > 0 && (
          <span className="text-muted-foreground/80">
            {details.map((detail, index) => (
              <Fragment key={index}>
                {(content || index > 0) && " · "}
                {detail}
              </Fragment>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * A finished turn's closing line under its last row, when no live summary row
 * carries it (history, or a device that did not watch the turn end). Spaced
 * like the summary row it stands in for.
 */
export function TurnFooterLine({ footer }: { footer: TurnFooter }) {
  return (
    <div className={TURN_CLOSING_SPACING}>
      <TurnSummaryDivider footer={footer} />
    </div>
  );
}

/**
 * Where the model writing the conversation changed: at the top of the turn it
 * took effect in, or before the first reply it wrote when the provider
 * applied it mid-turn.
 */
export function ModelSwitchDivider({ from, to }: ModelSwitch) {
  return (
    <div
      role="note"
      data-model-switch
      className="flex items-center gap-3 pt-2 pb-1 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border/70" aria-hidden />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium">Model</span>
        <span className="min-w-0 truncate font-mono text-[11px]">
          <span className="text-muted-foreground/70">{from}</span>
          {" → "}
          <span className="text-foreground/80">{to}</span>
        </span>
      </span>
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </div>
  );
}
