import { catalogMembers } from "./marketplace-catalog";
import { baseListing, pickMeta, type MarketplaceListing } from "./marketplace-listing-base";
import type { LspCatalog, LspInventory } from "./lsp/marketplace";
import type { LspMarketplacePackage } from "./marketplace-lsp-package";

export function lspListings(catalog?: LspCatalog, inventory?: LspInventory): MarketplaceListing[] {
  const groups = new Map<string, LspMarketplacePackage[]>();
  for (const entry of catalogMembers(catalog?.index?.signed.packages)) {
    if (entry.kind === "lsp")
      groups.set(entry.package.lsp.id, [
        ...(groups.get(entry.package.lsp.id) ?? []),
        entry.package,
      ]);
  }
  const installed = new Map(inventory?.servers.map((entry) => [entry.lsp_id, entry]));
  return [...new Set([...groups.keys(), ...installed.keys()])].map((id) => {
    const packages = groups.get(id) ?? [];
    const entry = installed.get(id);
    const recommended = catalog?.recommended_versions[id];
    const meta = pickMeta(packages, (item) => item.lsp.version, recommended);
    return {
      ...baseListing(
        "lsp",
        id,
        packages.map((item) => ({
          version: item.lsp.version,
          minApp: item.host.compatibility.min_app_version,
          maxApp: item.host.compatibility.max_app_version,
          platforms: Object.keys(item.lsp.distribution.binary),
          unavailable: catalog?.unavailable_versions?.[id]?.[item.lsp.version],
          blocked: catalog?.blocked_versions?.[id]?.[item.lsp.version],
        })),
        recommended,
        entry
          ? {
              version: entry.version ?? null,
              active: false,
              usable: entry.status !== "invalid",
              restartRequired: false,
              error: entry.error,
              managed: entry.status === "managed" || entry.status === "invalid",
            }
          : undefined,
      ),
      name: meta?.lsp.name ?? entry?.name ?? id,
      description: meta?.lsp.description ?? entry?.description ?? "",
      publisher: meta?.host.publisher,
      license: meta?.lsp.license,
      repository: meta?.lsp.repository,
      authors: [],
    };
  });
}
