import { type ReactNode } from "react";

import { useAutoLayoutStore } from "@/stores/auto-layout-store";

/**
 * Browser tab badge: a breathing dot while the agent drives this feature's
 * browser, so its activity is visible even when the Browser pane is hidden.
 */
export function AgentBrowserActivityDot({ featureId }: { featureId: number }): ReactNode {
  const active = useAutoLayoutStore((s) => s.agentBrowserActive[featureId] === true);
  if (!active) return null;
  return (
    <span
      role="status"
      aria-label="Agent is using the browser"
      title="Agent is using the browser"
      className="ml-0.5 animate-pulse size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}
