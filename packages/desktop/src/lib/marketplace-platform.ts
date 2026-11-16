import type { MarketplaceListing } from "./marketplace-listings";

/**
 * Whether browsing surfaces (Discover, spotlight, search, counts) should list
 * it. A package with no installable build for this platform is hidden; one that
 * is merely too new for this Cadencr is not (that is not a platform matter).
 * Installed items stay (the Library must show what is on disk), and detail
 * routes read the full list, so a deep link still opens its page.
 * Unlike `availableHere`, "protocol" does not hide: a newer Cadencr fixes that, never a platform.
 */
export function browsableListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  return listings.filter(
    (listing) =>
      listing.installed ||
      listing.versions.length === 0 ||
      listing.versions.some((entry) => entry.unavailable !== "platform"),
  );
}
