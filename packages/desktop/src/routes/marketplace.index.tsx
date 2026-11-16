import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  MARKETPLACE_VIEWS,
  MarketplaceHome,
  type MarketplaceHomeProps,
} from "@/components/marketplace/MarketplaceHome";
import { PLUGIN_KINDS } from "@/lib/marketplace-listings";
import { AGENT_EXTENSION_KINDS } from "@/lib/agent-extensions";

const searchSchema = z.object({
  view: z.enum(MARKETPLACE_VIEWS).optional().catch(undefined),
  kind: z
    .enum(["all", ...PLUGIN_KINDS, ...AGENT_EXTENSION_KINDS])
    .optional()
    .catch(undefined),
  q: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/marketplace/")({
  validateSearch: (search: Record<string, unknown>) => searchSchema.parse(search),
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
