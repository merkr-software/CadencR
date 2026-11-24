import { useCallback } from "react";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import {
  MarketplaceHome,
  type MarketplaceHomeProps,
} from "@/components/marketplace/MarketplaceHome";

export const Route = createLazyFileRoute("/marketplace/")({
  component: MarketplaceIndexRoute,
});

function MarketplaceIndexRoute(): React.JSX.Element {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/marketplace/" });
  // Stable: the search field debounces against it.
  const onChange = useCallback<MarketplaceHomeProps["onChange"]>(
    (next) =>
      void navigate({
        replace: next.query !== undefined,
        search: (previous) => ({
          view: next.view ?? previous.view,
          kind: next.kind ?? previous.kind,
          q: next.query !== undefined ? next.query || undefined : previous.q,
        }),
      }),
    [navigate],
  );
  return (
    <MarketplaceHome
      view={search.view ?? "discover"}
      kind={search.kind ?? "all"}
      query={search.q ?? ""}
      onChange={onChange}
    />
  );
}
