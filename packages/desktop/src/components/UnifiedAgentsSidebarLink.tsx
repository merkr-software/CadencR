import { memo, type ReactElement, type ReactNode } from "react";
import { LayoutGridIcon } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useLiveTotalWorkingCount } from "@/stores/session-status-selectors";
import { cn } from "@/lib/utils";

export const UnifiedAgentsSidebarLink = memo(function UnifiedAgentsSidebarLink(): ReactElement {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname === "/agents";
  // The only number worth showing here is how many agents are actually
  // working right now, read live from the single source of truth
  // (`session-status-store`). The old REST-fetched "total agents" badge was
  // `staleTime: Infinity` and never refetched, so it drifted out of sync —
  // dropped entirely. This count updates the instant a WS status event lands.
  const runningCount = useLiveTotalWorkingCount();

  return (
    <ShortcutTooltip label="Open unified agents" keys={["cmd", "shift", "R"]} className="w-full">
      <AgentsSidebarAnchor active={active}>
        <LayoutGridIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Agents</span>
        <RunningAgentsIndicator count={runningCount} />
      </AgentsSidebarAnchor>
    </ShortcutTooltip>
  );
});

function AgentsSidebarAnchor({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Link
      to="/agents"
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
 * established "running agent" color used by the sidebar feature rows
 * (`ProjectFeatureRow`'s `text-blue-500` working icon); grey matches the idle
 * dot used elsewhere (`CustomActionStatusDot`).
 */
function RunningAgentsIndicator({ count }: { count: number }): ReactElement {
  const running = count > 0;
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
      title={running ? `${count} agent${count === 1 ? "" : "s"} working` : "No agents working"}
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
