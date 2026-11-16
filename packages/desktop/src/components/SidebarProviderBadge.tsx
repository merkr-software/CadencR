import { memo, type CSSProperties, type ReactElement } from "react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { BotIcon } from "lucide-react";
import { useProviderMetadata } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";
import { thinkingEffortLabel, parseThinkingEffort } from "@/shared/thinking-effort";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/** A provider's mono mark tinted with the text color; a bot glyph without one. */
export function ProviderMonoMark({
  iconSrc,
  scale,
  className,
}: {
  iconSrc?: string | null;
  scale?: number | null;
  className?: string;
}): ReactElement {
  if (!iconSrc) return <BotIcon className={cn("size-3.5", className)} aria-hidden />;
  return (
    <span
      aria-hidden
      className={cn("provider-mark-tint size-3.5", className)}
      style={
        {
          "--provider-mark": `url("${iconSrc}")`,
          "--provider-mark-size": `${(scale ?? 1) * 100}%`,
        } as CSSProperties
      }
    />
  );
}

interface SidebarProviderBadgeProps {
  providerId?: string | null;
  modelId?: string | null;
  thinkingEffort?: string | null;
}

/** Identity only: live status belongs to the leading status indicator. */
export const SidebarProviderBadge = memo(function SidebarProviderBadge({
  providerId,
  modelId,
  thinkingEffort,
}: SidebarProviderBadgeProps): ReactElement | null {
  const meta = useProviderMetadata(providerId, null, "mono");
  const providerDisplay = useSidebarOption("provider");
  if (!meta || providerDisplay === "hidden") return null;

  const effort = parseThinkingEffort(thinkingEffort ?? undefined);
  const detail = [
    meta.label,
    modelId?.trim() || "Default",
    effort ? thinkingEffortLabel(effort) : "Default",
  ].join(" · ");

  return (
    <ShortcutTooltip label={detail} toRight className="sidebar-provider-logo shrink-0">
      <span
        role="img"
        aria-label={detail}
        data-provider-mark="mono"
        className="inline-flex size-3.5 items-center justify-center text-muted-foreground"
      >
        <ProviderMonoMark iconSrc={meta.iconSrc} scale={meta.monoIconScale} />
      </span>
    </ShortcutTooltip>
  );
});
