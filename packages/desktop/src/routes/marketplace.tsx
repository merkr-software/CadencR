import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AgentExtensionActionsProvider } from "@/components/marketplace/agent/AgentExtensionActions";
import { MarketplaceProvider } from "@/components/marketplace/MarketplaceContext";

export const Route = createFileRoute("/marketplace")({
  component: MarketplaceLayout,
});

/** One provider above the list and detail pages, so in-flight changes survive navigation. */
function MarketplaceLayout(): React.JSX.Element {
  return (
    <MarketplaceProvider>
      <AgentExtensionActionsProvider>
        <Outlet />
      </AgentExtensionActionsProvider>
    </MarketplaceProvider>
  );
}
