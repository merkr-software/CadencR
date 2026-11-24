import { useEffect, type ReactElement } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { UnifiedAgentsView } from "@/components/UnifiedAgentsView";
import { useIsMobile } from "@/hooks/useIsMobile";

export const Route = createFileRoute("/agents")({
  component: AgentsRoute,
});

/**
 * The unified agents grid is a dense desktop surface that makes no sense on a
 * phone: there, "Agents" is the inbox on the home page, so the phone layout is
 * sent to `#/` (one inbox, one implementation).
 */
function AgentsRoute(): ReactElement | null {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  useEffect(() => {
    if (isMobile) void navigate({ to: "/", replace: true });
  }, [isMobile, navigate]);

  if (isMobile) return null;
  return <UnifiedAgentsView />;
}
