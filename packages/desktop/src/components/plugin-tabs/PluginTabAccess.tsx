import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type CSSProperties, type ReactElement } from "react";
import { CpuIcon, TerminalIcon } from "lucide-react";

import type { TabAccessLevel } from "@/api/generated";
import { cn } from "@/lib/utils";

import { accessLevelCopy, ACCESS_LEVEL_TONE } from "./plugin-tab-access";

/** The level as a pill: "Read-only", "Runs commands" or "Native code". */
export function PluginTabAccessBadge({ level }: { level: TabAccessLevel }): ReactElement {
  const { t } = useUiTranslation();
  const copy = accessLevelCopy(level, t);
  return (
    <span
      data-access-level={level}
      title={copy.summary}
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
        ACCESS_LEVEL_TONE[level],
      )}
    >
      {copy.label}
    </span>
  );
}

const MARK_TONE: Record<Exclude<TabAccessLevel, "ui">, CSSProperties> = {
  commands: { color: "var(--acc-yellow)" },
  backend: { color: "var(--acc-red)" },
};

/**
 * A glyph for a tab that reaches past its page — a terminal for one that runs
 * commands, a chip for one that runs native code — so the tab strip, not
 * only Settings, says what the tab can do. Nothing for a read-only tab.
 */
export const PluginTabAccessMark = memo(function PluginTabAccessMark({
  level,
  className,
}: {
  level: TabAccessLevel;
  className?: string;
}): ReactElement | null {
  const { t } = useUiTranslation();
  if (level === "ui") return null;
  const Icon = level === "backend" ? CpuIcon : TerminalIcon;
  const copy = accessLevelCopy(level, t);
  return (
    <span
      role="img"
      aria-label={copy.label}
      title={t("customTabs.access.markTitle", "{{label}}: {{summary}}", { ...copy })}
      data-access-mark={level}
      className={cn("inline-flex shrink-0", className)}
    >
      {/* Inline: the active tab trigger paints every glyph --primary and menu
          items paint uncolored glyphs muted; the level's tone must win both. */}
      <Icon className="size-3" style={MARK_TONE[level]} aria-hidden />
    </span>
  );
});
