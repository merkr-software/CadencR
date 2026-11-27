import { CloudOff, PackageOpen, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAgo } from "@/lib/date-utils";
import { useUiTranslation } from "@/lib/i18n/ui";
import { isStandalone } from "@/lib/marketplace-plugin-listings";
import { useMarketplaceState } from "./MarketplaceContext";
import { CheckCatalogButton, MarketplaceEmpty } from "./MarketplaceStates";

interface LibraryEmptyProps {
  view: "installed" | "updates";
  publishedAt?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onDiscover: () => void;
}

/** Why the Installed or Updates list is empty — never "up to date" when that is unknown. */
export function LibraryEmpty(props: LibraryEmptyProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const state = useMarketplaceState();
  const { view, refreshing, onRefresh } = props;
  const hasUnfilteredResults = state.listings.some((listing) =>
    view === "updates" ? !!listing.update && isStandalone(listing) : !!listing.installed,
  );
  const inventoryUnavailable =
    state.providers.inventoryQuery.isError ||
    state.themes.inventory.isError ||
    state.tabs.inventory.isError ||
    state.tabs.summaries.isError ||
    state.lsps.inventory.isError;
  const updatesUnknown =
    inventoryUnavailable ||
    !state.catalogUsable.provider ||
    !state.catalogUsable.theme ||
    !state.catalogUsable.tab ||
    !state.catalogUsable.lsp ||
    state.providers.catalogQuery.isError ||
    state.themes.catalog.isError ||
    state.tabs.catalog.isError ||
    state.lsps.catalog.isError;
  if (hasUnfilteredResults)
    return (
      <MarketplaceEmpty
        icon={Search}
        title={
          view === "updates"
            ? t(
                "marketplace.marketplaceLibrary.noUpdatesMatchYourSearch",
                "No updates match your search",
              )
            : t(
                "marketplace.marketplaceLibrary.noInstalledPluginsMatchYourSearch",
                "No installed plugins match your search",
              )
        }
        detail={t(
          "marketplace.marketplaceLibrary.noSearchMatchesDetail",
          "Try another search or clear it to see all results.",
        )}
      />
    );
  if (view === "updates" && state.catalogMissing && !inventoryUnavailable)
    return (
      <MarketplaceEmpty
        icon={CloudOff}
        title={t(
          "marketplace.marketplaceLibrary.updatesArenTAvailableInThisBuild",
          "Updates aren't available in this build",
        )}
        detail={t(
          "marketplace.marketplaceLibrary.updatesNotInBuildDetail",
          "This build isn't connected to a plugin catalog, so there is nothing to check installed plugins against.",
        )}
      />
    );
  if (view === "updates" ? updatesUnknown : inventoryUnavailable)
    return (
      <MarketplaceEmpty
        icon={CloudOff}
        title={
          view === "updates"
            ? t(
                "marketplace.marketplaceLibrary.updatesCouldNotBeDetermined",
                "Updates could not be determined",
              )
            : t(
                "marketplace.marketplaceLibrary.installedPluginsCouldNotBeLoaded",
                "Installed plugins could not be loaded",
              )
        }
        detail={t(
          "marketplace.marketplaceLibrary.failedLoadDetail",
          "Check the notices above and try again. Installed plugins remain manageable when their inventory is available.",
        )}
        action={
          !inventoryUnavailable && (
            <CheckCatalogButton
              refreshing={refreshing}
              onRefresh={onRefresh}
              label={t("marketplace.marketplaceLibrary.tryAgain", "Try again")}
            />
          )
        }
      />
    );
  return <AvailableLibraryEmpty {...props} />;
}

function AvailableLibraryEmpty({
  view,
  refreshing,
  publishedAt,
  onDiscover,
  onRefresh,
}: LibraryEmptyProps): React.JSX.Element {
  const { t } = useUiTranslation();
  return view === "updates" ? (
    <MarketplaceEmpty
      icon={PackageOpen}
      title={t("marketplace.marketplaceLibrary.everythingIsUpToDate", "Everything is up to date")}
      detail={
        publishedAt
          ? t(
              "marketplace.marketplaceLibrary.upToDatePublished",
              "Updates are never automatic: each one installs the exact version shown. Catalog published {{published}}.",
              { published: formatAgo(publishedAt) },
            )
          : t(
              "marketplace.marketplaceLibrary.upToDateDetail",
              "Updates are never automatic: each one installs the exact version shown.",
            )
      }
      action={<CheckCatalogButton refreshing={refreshing} onRefresh={onRefresh} />}
    />
  ) : (
    <MarketplaceEmpty
      icon={PackageOpen}
      title={t(
        "marketplace.marketplaceLibrary.nothingInstalledFromTheMarketplaceYet",
        "Nothing installed from the marketplace yet",
      )}
      detail={t(
        "marketplace.marketplaceLibrary.nothingInstalledDetail",
        "Themes, providers, language servers and custom tabs you install show up here, with their version and history.",
      )}
      action={
        <Button size="sm" onClick={onDiscover}>
          {t("marketplace.marketplaceLibrary.discoverPlugins", "Discover plugins")}
        </Button>
      }
    />
  );
}
