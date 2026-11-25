import { useUiTranslation } from "@/lib/i18n/ui";
import { ArrowUpCircle, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { KINDS, type MarketplaceKind } from "../kinds";
import { initials } from "../PluginBits";

/** Monogram on the rail-tile grammar: registries and CLI marketplaces serve no icons. */
export function AgentMark({
  kind,
  name,
  size = 40,
}: {
  kind: MarketplaceKind;
  name: string;
  size?: number;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("mp-mark", KINDS[kind].tone)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(name)}
    </span>
  );
}

/** Update › Installed in N CLIs › nothing, like every other listing's single badge. */
export function AgentStateBadge({
  installedIn,
  update,
  className,
}: {
  installedIn: number;
  update?: string | null;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  if (update)
    return (
      <Badge
        variant="ghost"
        className={cn("h-5 px-2 text-[11px] bg-primary/12 text-primary", className)}
      >
        <ArrowUpCircle aria-hidden="true" />
        {t("marketplace.agent.updateVersion", "Update {{version}}", { version: update })}
      </Badge>
    );
  if (installedIn === 0) return null;
  return (
    <Badge
      variant="ghost"
      className={cn("h-5 px-2 text-[11px] bg-foreground/7 text-muted-foreground", className)}
    >
      <Check aria-hidden="true" />
      {installedIn > 1
        ? t("marketplace.agent.agentBits.installedIn", "Installed in {{count, number}}", {
            count: installedIn,
          })
        : t("marketplace.agent.agentBits.installed", "Installed")}
    </Badge>
  );
}
