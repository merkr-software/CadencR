import { memo, type CSSProperties, type ReactElement } from "react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { BotIcon } from "lucide-react";
import { useProviderMetadata } from "@/lib/provider-icons";
import { thinkingEffortLabel, parseThinkingEffort } from "@/shared/thinking-effort";
import type { LiveAgentStatus } from "@/types/agent";
import { cn } from "@/lib/utils";

interface SidebarProviderBadgeProps {
  providerId?: string | null;
  modelId?: string | null;
  thinkingEffort?: string | null;
  liveStatus?: LiveAgentStatus;
  unread?: boolean;
  className?: string;
}

/**
 * Compact provider mark on sidebar conversation rows. Live status reuses the
 * colors that used to sit on a separate robot glyph.
 */
export const SidebarProviderBadge = memo(function SidebarProviderBadge({
  providerId,
  modelId,
  thinkingEffort,
  liveStatus = "idle",
  unread = false,
  className,
}: SidebarProviderBadgeProps): ReactElement | null {
  const meta = useProviderMetadata(providerId, null, "mono");
  const working = liveStatus === "agent";
  const waiting = liveStatus === "question";
  const showUnread = unread && liveStatus === "idle";
  if (!meta && !working && !showUnread) return null;

  const effort = parseThinkingEffort(thinkingEffort ?? undefined);
  const modelLabel = modelId?.trim() || "Default";
  const thinkingLabel = effort ? thinkingEffortLabel(effort) : "Default";
  const detail = providerMarkDetail(meta?.label ?? "Agent", modelLabel, thinkingLabel, {
    working,
    unread: showUnread,
  });

  const mark = (
    <span
      role={waiting ? undefined : "img"}
      aria-label={waiting ? undefined : detail}
      aria-hidden={waiting || undefined}
      data-provider-mark={
        working ? "working" : waiting ? "waiting" : showUnread ? "unread" : "idle"
      }
      className={cn(
        "relative inline-flex size-3.5 items-center justify-center",
        working && "animate-pulse text-blue-500",
        !working && !waiting && "text-muted-foreground",
      )}
    >
      {meta?.iconSrc ? (
        <span
          aria-hidden
          className="provider-mark-tint size-3.5"
          style={{ "--provider-mark": `url("${meta.iconSrc}")` } as CSSProperties}
        />
      ) : meta ? (
        <BotIcon className="size-3.5" aria-hidden />
      ) : working ? (
        <span className="size-2 rounded-full bg-blue-500" aria-hidden />
      ) : null}
      {showUnread ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-blue-500 ring-1 ring-sidebar"
          aria-hidden
        />
      ) : null}
    </span>
  );

  if (waiting) return mark;

  return (
    <ShortcutTooltip label={detail} toRight className={cn("shrink-0", className)}>
      {mark}
    </ShortcutTooltip>
  );
});

function providerMarkDetail(
  providerLabel: string,
  modelLabel: string,
  thinkingLabel: string,
  state: { working: boolean; unread: boolean },
): string {
  const parts = [providerLabel, modelLabel, thinkingLabel];
  if (state.working) parts.push("Working");
  if (state.unread) parts.push("Unread");
  return parts.join(" · ");
}
