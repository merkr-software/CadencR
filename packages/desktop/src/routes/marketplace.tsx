import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MarketplaceProvider } from "@/components/marketplace/MarketplaceContext";

export const Route = createFileRoute("/marketplace")({
  component: MarketplaceLayout,
});

/** One provider above the list and detail pages, so in-flight changes survive navigation. */
function MarketplaceLayout(): React.JSX.Element {
  return (
    <MarketplaceProvider>
      <Outlet />
    </MarketplaceProvider>
  );
}
