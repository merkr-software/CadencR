import { useMemo } from "react";
import { marketplaceError } from "@/lib/marketplace";
import {
  downloadableUpdate,
  type MarketplaceListing,
  type PluginKind,
} from "@/lib/marketplace-listings";
import { versionProblem } from "@/lib/marketplace-listing-base";
import {
  installedPluginMembers,
  pluginMembers,
  pluginSteps,
} from "@/lib/marketplace-plugin-listings";
import { KINDS } from "./kinds";
import { useMarketplaceState } from "./MarketplaceContext";

const NO_CATALOG = "A current signed catalog is required to install.";

/** How a plugin member is named when a sequence stops on it. */
export function memberLabel(member: MarketplaceListing): string {
  return `${member.name} (${KINDS[member.kind].label.toLowerCase()})`;
}

type State = ReturnType<typeof useMarketplaceState>;

function releaseInstallable(plugin: MarketplaceListing, version: string): boolean {
  const release = plugin.versions.find((entry) => entry.version === version);
  return !!release && !versionProblem(release);
}

/**
 * The one kind branch: each kind's mutation, with its own catalog's signed
 * envelope. The awaited forms use `mutateAsync`, which settles even when the
 * page that started the sequence has unmounted (per-call `mutate` callbacks
 * would not fire then, and a plugin install would stall on its next member).
 */
function kindDispatch(
  providers: State["providers"],
  themes: State["themes"],
  tabs: State["tabs"],
  lsps: State["lsps"],
) {
  /** Install, or move an installed member to `version`. */
  const run = (listing: MarketplaceListing, version: string, mode: "mutate" | "mutateAsync") => {
    const kind =
      listing.installed && !(listing.kind === "lsp" && !listing.installed.managed)
        ? "update"
        : "install";
    const providerIndex = providers.catalogQuery.data?.index;
    const themeIndex = themes.catalog.data?.index;
    const tabIndex = tabs.catalog.data?.index;
    if (listing.kind === "provider" && providerIndex)
      return providers.mutation[mode]({ kind, id: listing.id, version, index: providerIndex });
    if (listing.kind === "theme" && themeIndex)
      return themes.mutation[mode]({ kind, id: listing.id, version, index: themeIndex });
    if (listing.kind === "tab" && tabIndex)
      return tabs.mutation[mode]({ kind, id: listing.id, version, index: tabIndex });
    if (listing.kind === "lsp" && lsps.catalog.data?.index)
      return lsps.mutation[mode]({ kind, id: listing.id, version });
    throw new Error(NO_CATALOG);
  };
  /** Resolves once the backend confirmed and the kind's state was reloaded. */
  const sendAsync = async (listing: MarketplaceListing, version: string) => {
    await run(listing, version, "mutateAsync");
  };
  const removeAsync = async (listing: MarketplaceListing) => {
    if (listing.kind === "provider")
      await providers.mutation.mutateAsync({ kind: "remove", id: listing.id });
    else if (listing.kind === "tab")
      await tabs.mutation.mutateAsync({ kind: "remove", id: listing.id });
    // The confirmation dialog said selections fall back to a built-in theme.
    else if (listing.kind === "theme")
      await themes.mutation.mutateAsync({ kind: "remove", id: listing.id, confirmFallback: true });
    else if (listing.kind === "lsp")
      await lsps.mutation.mutateAsync({ kind: "remove", id: listing.id });
    else throw new Error("A plugin is removed member by member.");
  };
  return {
    send: (listing: MarketplaceListing, version: string) => void run(listing, version, "mutate"),
    sendAsync,
    removeAsync,
  };
}

function pluginInstaller(
  sendAsync: (listing: MarketplaceListing, version: string) => Promise<void>,
  listingsByKey: State["listingsByKey"],
  setPluginRun: State["setPluginRun"],
) {
  /**
   * Every member `version` still needs, one at a time in catalog order. Stops
   * at the first failure, kept (by member) in the run state the page shows;
   * resolves with that failure's sentence, or null once every member is in.
   */
  return async (plugin: MarketplaceListing, version: string): Promise<string | null> => {
    const steps = pluginSteps(pluginMembers(plugin, version, listingsByKey), version);
    for (const [index, step] of steps.entries()) {
      const member = step.listing;
      const name = member ? memberLabel(member) : step.ref.id;
      setPluginRun({
        key: plugin.key,
        status: "running",
        member: name,
        step: index + 1,
        total: steps.length,
      });
      try {
        if (!member) throw new Error(`${step.ref.id} is not in the loaded catalog.`);
        await sendAsync(member, version);
      } catch (error) {
        const message = marketplaceError(error) ?? "The change was not confirmed.";
        setPluginRun({ key: plugin.key, status: "failed", member: name, message });
        return `${plugin.name} stopped at ${name}: ${message}`;
      }
    }
    setPluginRun(null);
    return null;
  };
}

/**
 * Install/update dispatch for every kind. Every request carries the exact
 * version and the untouched signed envelope; nothing changes on screen until
 * the backend confirms (inventories are refetched by the kind's own hook).
 * A plugin is its members, each sent in turn through its own kind's mutation.
 */
export function usePluginActions() {
  const {
    providers,
    lsps,
    themes,
    tabs,
    catalogUsable,
    listings,
    listingsByKey,
    pluginRun,
    setPluginRun,
  } = useMarketplaceState();
  return useMemo(() => {
    const providerReady =
      catalogUsable.provider &&
      !!providers.inventoryQuery.data &&
      !providers.inventoryQuery.isError &&
      providers.inventoryQuery.data.trust.status === "configured";
    const kindReady: Record<PluginKind, boolean> = {
      provider: providerReady,
      lsp: catalogUsable.lsp && lsps.inventory.isSuccess,
      theme: catalogUsable.theme && themes.inventory.isSuccess,
      tab: catalogUsable.tab && tabs.inventory.isSuccess,
    };
    const mutations = {
      provider: providers.mutation,
      theme: themes.mutation,
      tab: tabs.mutation,
      lsp: lsps.mutation,
    };
    const kindsOf = (listing: MarketplaceListing): PluginKind[] =>
      listing.kind === "plugin" ? listing.contributes : [listing.kind];

    const { send, sendAsync, removeAsync } = kindDispatch(providers, themes, tabs, lsps);
    const installPlugin = pluginInstaller(sendAsync, listingsByKey, setPluginRun);

    return {
      /** Whether every kind this listing touches can install or update right now. */
      canInstall: (listing: MarketplaceListing) =>
        listing.inCatalog && kindsOf(listing).every((kind) => kindReady[kind]),
      /** A change for one of this listing's kinds is in flight (one at a time per kind). */
      busy: (listing: MarketplaceListing) =>
        pluginRun?.status === "running" ||
        kindsOf(listing).some((kind) => mutations[kind].isPending),
      /** A change for this exact plugin is in flight. */
      pending: (listing: MarketplaceListing) => {
        if (listing.kind === "plugin")
          return pluginRun?.status === "running" && pluginRun.key === listing.key;
        const mutation = mutations[listing.kind];
        return mutation.isPending && mutation.variables?.id === listing.id;
      },
      /**
       * Fire and forget: a kind's failure shows in the activity panel, a
       * plugin's in its run state (which member stopped it, and why).
       */
      install: (listing: MarketplaceListing, version: string) => {
        if (listing.kind === "plugin") void installPlugin(listing, version);
        else send(listing, version);
      },
      /** Removes one member; rejects with the service's error. */
      remove: removeAsync,
      /** Removes every installed member of a plugin in turn, stopping at the first failure. */
      removePlugin: async (plugin: MarketplaceListing) => {
        for (const member of installedPluginMembers(plugin, listings)) {
          try {
            await removeAsync(member);
          } catch (error) {
            throw new Error(`${memberLabel(member)}: ${marketplaceError(error) ?? "not removed"}`);
          }
        }
      },
      /**
       * Each pending update in turn, at its exact recommended version. Rejects
       * on the first failure so the caller can say why the queue stopped.
       */
      updateAll: async (queue: MarketplaceListing[]) => {
        for (const listing of queue) {
          const version = downloadableUpdate(listing);
          if (!version) continue;
          if (listing.kind !== "plugin") await sendAsync(listing, version);
          // A release that cannot install whole here is never walked member by member.
          else if (!releaseInstallable(listing, version)) continue;
          else {
            const failure = await installPlugin(listing, version);
            if (failure) throw new Error(failure);
          }
        }
      },
    };
  }, [
    providers,
    themes,
    tabs,
    lsps,
    catalogUsable,
    listings,
    listingsByKey,
    pluginRun,
    setPluginRun,
  ]);
}
