import { catalogPlugins, type PluginPackage } from "./marketplace-catalog";
import {
  baseListing,
  listingKey,
  versionProblem,
  type InstalledState,
  type ListingVersion,
  type MarketplaceListing,
  type PluginKind,
  type PluginMemberRef,
} from "./marketplace-listing-base";
import { compareVersions, lowestVersion, newerVersion, sortVersions } from "./marketplace-versions";

/**
 * Multi-export plugins. A plugin is never installed as such: its members are
 * ordinary single-kind packages the service resolves by their own ids. So a
 * plugin listing holds no state of its own — everything here derives from its
 * member listings, which carry the host's verdicts (recommendations,
 * availability, revocations) exactly as for standalone packages.
 */

const memberKey = (member: PluginMemberRef) => listingKey(member.kind, member.id);

function memberId(entry: PluginPackage["contributes"][number]): PluginMemberRef | null {
  switch (entry.kind) {
    case "theme":
      return { kind: "theme", id: entry.package.theme.id };
    case "provider":
      return { kind: "provider", id: entry.package.agent.id };
    case "tab":
      return { kind: "tab", id: entry.package.tab.id };
    case "lsp":
      return { kind: "lsp", id: entry.package.lsp.id };
    case "unknown":
      return null;
  }
}

/** Plugin releases by plugin id; the first copy of a version wins across kind catalogs. */
function groupPlugins(catalogs: (readonly unknown[] | undefined)[]): Map<string, PluginPackage[]> {
  const groups = new Map<string, PluginPackage[]>();
  for (const entry of catalogs.flatMap((packages) => catalogPlugins(packages))) {
    const versions = groups.get(entry.plugin.id) ?? [];
    if (!versions.some((item) => item.plugin.version === entry.plugin.version))
      groups.set(entry.plugin.id, [...versions, entry]);
  }
  return groups;
}

/** Listings by key, so a plugin resolves each member without scanning every listing. */
type Lookup = ReadonlyMap<string, MarketplaceListing>;

export function listingIndex(listings: MarketplaceListing[]): Lookup {
  return new Map(listings.map((listing) => [listing.key, listing]));
}

/** Why a release does not install here: an unknown member kind, else its members' verdicts. */
function releaseUnavailable(
  unknownKinds: string[],
  entries: (ListingVersion | undefined)[],
): ListingVersion["unavailable"] {
  if (unknownKinds.length) return "protocol";
  if (entries.some((entry) => entry?.unavailable === "platform")) return "platform";
  if (entries.some((entry) => entry?.unavailable === "protocol")) return "protocol";
  return entries.find((entry) => entry?.unavailable)?.unavailable;
}

function releaseVersion(item: PluginPackage, lookup: Lookup): ListingVersion {
  const version = item.plugin.version;
  const members = item.contributes.flatMap((entry) => memberId(entry) ?? []);
  const unknownKinds = item.contributes.flatMap((entry) =>
    entry.kind === "unknown" ? [entry.declared] : [],
  );
  const listings = members.map((member) => lookup.get(memberKey(member)));
  const entries = listings.map((listing) => listing?.versions.find((v) => v.version === version));
  const blockedAt = entries.findIndex((entry) => entry?.blocked);
  const unavailable = releaseUnavailable(unknownKinds, entries);
  // A member whose kind catalog does not list this release (stale, or it
  // failed to load) cannot be installed at it: the release is incomplete here.
  const incomplete = members.flatMap((member, index) => (entries[index] ? [] : [member.id]));
  return {
    version,
    minApp: item.host.compatibility.min_app_version,
    maxApp: item.host.compatibility.max_app_version,
    platforms: [...new Set(entries.flatMap((entry) => entry?.platforms ?? []))],
    ...(unavailable ? { unavailable } : {}),
    ...(blockedAt >= 0
      ? {
          blocked: `${listings[blockedAt]?.name ?? members[blockedAt].id}: ${entries[blockedAt]?.blocked}`,
        }
      : {}),
    members,
    unknownKinds,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

/**
 * The newest release that installs here whole and that every one of its
 * members' host recommendations reaches (a member recommended below it means
 * the host found that release incompatible for it). Nothing is derived from
 * compatibility here: no member recommendation, no plugin one.
 */
function recommendedRelease(versions: ListingVersion[], lookup: Lookup): string | undefined {
  return versions.find(
    (release) =>
      !versionProblem(release) &&
      !release.unknownKinds?.length &&
      !!release.members?.length &&
      release.members.every((member) => {
        const recommended = lookup.get(memberKey(member))?.recommended;
        return !!recommended && (compareVersions(recommended, release.version) ?? -1) >= 0;
      }),
  )?.version;
}

/**
 * Installed when every member of the installed release is installed at that
 * version; partial otherwise. The release is the newest one any member is at,
 * so a member a later release dropped never holds the plugin back.
 */
function releaseInstalled(
  members: PluginMemberRef[],
  versions: ListingVersion[],
  lookup: Lookup,
): InstalledState | undefined {
  const all = members.flatMap((member) => lookup.get(memberKey(member)) ?? []);
  const installed = all.filter((listing) => listing.installed);
  if (!installed.length) return undefined;
  const newest = sortVersions(
    installed.flatMap((listing) =>
      listing.installed?.version ? [{ version: listing.installed.version }] : [],
    ),
  )[0]?.version;
  const release = versions.find((entry) => entry.version === newest);
  const releaseKeys = new Set((release?.members ?? []).map(memberKey));
  const current = release ? installed.filter((listing) => releaseKeys.has(listing.key)) : installed;
  const version =
    lowestVersion(current.flatMap((listing) => listing.installed?.version ?? [])) ?? null;
  const complete = release
    ? !release.unknownKinds?.length &&
      (release.members ?? []).every(
        (member) =>
          lookup.get(memberKey(member))?.installed?.version === version &&
          !(member.kind === "lsp" && !lookup.get(memberKey(member))?.installed?.managed),
      )
    : current.every((listing) => listing.installed?.version === version);
  const dates = (field: "installedAt" | "updatedAt") =>
    current.flatMap((listing) => listing.installed?.[field] ?? []).sort();
  const problem = (field: "error" | "blocked") => {
    const listing = current.find((item) => item.installed?.[field]);
    return listing ? `${listing.name}: ${listing.installed?.[field]}` : null;
  };
  return {
    version,
    active: false,
    usable: current.every((listing) => listing.installed?.usable),
    restartRequired: current.some((listing) => listing.installed?.restartRequired),
    error: problem("error"),
    blocked: problem("blocked"),
    installedAt: dates("installedAt")[0],
    updatedAt: dates("updatedAt").at(-1),
    partial: !complete,
  };
}

function uniqueKinds(members: PluginMemberRef[]): PluginKind[] {
  return [...new Set(members.map((member) => member.kind))];
}

function pluginListing(id: string, releases: PluginPackage[], lookup: Lookup): MarketplaceListing {
  const versions = sortVersions(releases.map((item) => releaseVersion(item, lookup)));
  const recommended = recommendedRelease(versions, lookup);
  const everyMember = [
    ...new Map(
      versions.flatMap((entry) => entry.members ?? []).map((m) => [memberKey(m), m]),
    ).values(),
  ];
  const installed = releaseInstalled(everyMember, versions, lookup);
  const shown =
    versions.find((entry) => entry.version === installed?.version) ??
    versions.find((entry) => entry.version === recommended) ??
    versions[0];
  const meta =
    releases.find((item) => item.plugin.version === shown?.version)?.plugin ?? releases[0].plugin;
  const host = releases.find((item) => item.plugin.version === shown?.version)?.host;
  const members = shown?.members ?? [];
  return {
    ...baseListing("plugin", id, versions, recommended, installed),
    contributes: uniqueKinds(members),
    members,
    name: meta.name,
    description: meta.description,
    publisher: host?.publisher,
    license: meta.license,
    repository: meta.repository,
    authors: [],
  };
}

/** One listing per plugin id, derived from the already built member listings. */
export function pluginListings(
  catalogs: (readonly unknown[] | undefined)[],
  members: MarketplaceListing[],
): MarketplaceListing[] {
  const lookup = listingIndex(members);
  return [...groupPlugins(catalogs)].map(([id, releases]) => pluginListing(id, releases, lookup));
}

/** A plugin member as the detail page shows it: its reference and, once known, its listing. */
export interface PluginMember {
  ref: PluginMemberRef;
  listing?: MarketplaceListing;
}

/** The members of one plugin release (the listing's own when that version is not listed). */
export function pluginMembers(
  plugin: MarketplaceListing,
  version: string | undefined,
  lookup: Lookup,
): PluginMember[] {
  const refs =
    plugin.versions.find((entry) => entry.version === version)?.members ?? plugin.members ?? [];
  return refs.map((ref) => ({ ref, listing: lookup.get(memberKey(ref)) }));
}

/** Every installed member of a plugin, whichever release brought it. */
export function installedPluginMembers(
  plugin: MarketplaceListing,
  listings: MarketplaceListing[],
): MarketplaceListing[] {
  return listings.filter(
    (item) =>
      item.partOf?.id === plugin.id &&
      item.installed &&
      !(item.kind === "lsp" && !item.installed.managed),
  );
}

/**
 * Whether a listing is browsed on its own: everything but plugin members,
 * which Discover, Updates and the update counts reach through their plugin.
 */
export function isStandalone(listing: MarketplaceListing): boolean {
  return !listing.partOf;
}

/** The members a move to `version` still has to install or change, in catalog order. */
export function pluginSteps(members: PluginMember[], version: string): PluginMember[] {
  return members.filter(
    (member) =>
      member.listing?.installed?.version !== version ||
      (member.listing.kind === "lsp" && !member.listing.installed?.managed),
  );
}

/** How `version` relates to what is installed: install, update or change (or nothing left). */
export function pluginOffer(
  plugin: MarketplaceListing,
  steps: PluginMember[],
  version: string,
): "install" | "complete" | "update" | "change" | null {
  if (!steps.length) return null;
  const installed = plugin.installed?.version;
  if (!installed) return "install";
  if (installed === version) return "complete";
  return newerVersion(version, installed) ? "update" : "change";
}
