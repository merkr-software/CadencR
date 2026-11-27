import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import { InboxIcon, LayoutGridIcon } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { useLiveTotalWorkingCount } from "@/stores/session-status-selectors";
import { cn } from "@/lib/utils";

export const UnifiedAgentsSidebarLink = memo(function UnifiedAgentsSidebarLink(): ReactElement {
  const { t } = useUiTranslation();
  // A boolean, so navigating between other pages doesn't re-render the link.
  const active = useRouterState({ select: (state) => state.location.pathname === "/agents" });
  // The only number worth showing here is how many agents are actually
  // working right now, read live from the single source of truth
  // (`session-status-store`). The old REST-fetched "total agents" badge was
  // `staleTime: Infinity` and never refetched, so it drifted out of sync —
  // dropped entirely. This count updates the instant a WS status event lands.
  const runningCount = useLiveTotalWorkingCount();
  const openKeys = useShortcutKeys("open-unified-agents");

  return (
    <ShortcutTooltip
      label={t("sidebar.unifiedAgentsSidebarLink.openUnifiedAgents", "Open unified agents")}
      keys={openKeys}
      className="w-full"
    >
      <AgentsSidebarAnchor active={active}>
        <LayoutGridIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t("sidebar.unifiedAgentsSidebarLink.agents", "Agents")}
        </span>
        <RunningAgentsIndicator count={runningCount} />
      </AgentsSidebarAnchor>
    </ShortcutTooltip>
  );
});

/**
 * The phone layout's "Agents": the inbox on the home page (`#/`), first in
 * the drawer, so a conversation is always one tap from what waits elsewhere.
 * The unified agents grid is desktop-only (`/agents` sends a phone home).
 */
export const PhoneInboxSidebarLink = memo(function PhoneInboxSidebarLink(): ReactElement {
  const { t } = useUiTranslation();
  // `#/?projectId=` opens a project's conversation, not the inbox.
  const active = useRouterState({
    select: (state) => state.location.pathname === "/" && state.location.searchStr === "",
  });
  const runningCount = useLiveTotalWorkingCount();
  return (
    <AgentsSidebarAnchor active={active} to="/">
      <InboxIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {t("sidebar.unifiedAgentsSidebarLink.agents", "Agents")}
      </span>
      <RunningAgentsIndicator count={runningCount} />
    </AgentsSidebarAnchor>
  );
});

function AgentsSidebarAnchor({
  active,
  to = "/agents",
  children,
}: {
  active: boolean;
  to?: "/agents" | "/";
  children: ReactNode;
}): ReactElement {
  return (
    <Link
      to={to}
      data-nav-item
      data-nav-type="agents"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
        "focus-visible:bg-accent focus-visible:outline-none",
        active
          ? "bg-accent/50 text-accent-foreground font-medium"
          : "text-foreground hover:bg-accent/50",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * Live "agents working" badge: a breathing blue dot + count when one or more
 * agents are running, an idle grey dot + count when none are. Blue matches the
 * working tint on each row's provider mark (`text-blue-500`).
 */
function RunningAgentsIndicator({ count }: { count: number }): ReactElement {
  const { t } = useUiTranslation();
  const running = count > 0;
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
      title={
        running
          ? t("sidebar.unifiedAgentsSidebarLink.agentsWorking", "{{count}} agents working", {
              count,
              defaultValue_one: "{{count}} agent working",
            })
          : t("sidebar.unifiedAgentsSidebarLink.noAgentsWorking", "No agents working")
      }
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          running ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/40",
        )}
      />
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
