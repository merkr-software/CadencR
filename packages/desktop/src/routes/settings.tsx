import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  isLegacyMarketplaceLink,
  parseSettingsSearch,
} from "@/components/settings/settings-navigation";

/** Settings' search and redirect; the page is in `settings.lazy.tsx`. */
export const Route = createFileRoute("/settings")({
  validateSearch: parseSettingsSearch,
  beforeLoad: ({ search }) => {
    if (isLegacyMarketplaceLink(search)) throw redirect({ to: "/marketplace" });
  },
});
