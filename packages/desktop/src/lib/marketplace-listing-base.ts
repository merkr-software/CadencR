import { newerVersion, sortVersions } from "./marketplace-versions";
import type { TabVersionUnavailable } from "@/api/generated";
import type { TabNativeCode } from "./marketplace-tab-package";

/**
 * What a marketplace package adds to Cadencr — the single kinds the signed
 * catalog serves, standalone or as members of a plugin.
 */
export const PLUGIN_KINDS = ["theme", "provider", "tab", "lsp"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];
/** What a listing is: one single-kind package, or a plugin contributing several. */
export type ListingKind = PluginKind | "plugin";
export function isPluginKind(value: string): value is PluginKind {
  return (PLUGIN_KINDS as readonly string[]).includes(value);
}
export function isListingKind(value: string): value is ListingKind {
  return value === "plugin" || isPluginKind(value);
}

/** A listing's key, unique across kinds: `${kind}:${id}`. */
export function listingKey(kind: ListingKind, id: string): string {
  return `${kind}:${id}`;
}

/** One member of a plugin release, by its own kind and id. */
export interface PluginMemberRef {
  kind: PluginKind;
  id: string;
}

export interface ListingVersion {
  version: string;
  minApp: string;
  maxApp?: string | null;
  /** Provider or tab backend binary targets (`darwin-aarch64`, …); empty for themes. */
  platforms: string[];
  /**
   * Why it can't be installed on this computer — a provider or tab backend with
   * no binary for this platform, or a newer backend protocol. Absent: it can.
   */
  unavailable?: TabVersionUnavailable | "node" | "policy" | "compatibility";
  /** Custom tab: the native backend this exact version ships (`null`: none). */
  nativeCode?: TabNativeCode | null;
  /** Custom tab: why Cadencr's revocation policy blocks this exact version here. */
  blocked?: string;
  /** Theme archive digest — keys verified previews to this exact archive. */
  sha256?: string;
  /** Plugin: the members this release contributes, in catalog order. */
  members?: PluginMemberRef[];
  /** Plugin: member kinds this Cadencr does not know (it needs a newer one). */
  unknownKinds?: string[];
  /**
   * Plugin: members whose kind catalog does not list this release (stale or
   * failed to load), so it cannot be installed whole until it does.
   */
  incomplete?: string[];
}

export type VersionProblem =
  | "outdated"
  | "unavailable"
  | "blocked"
  | "incomplete"
  | "runtime"
  | "policy"
  | "compatibility";

/** What keeps this exact version from installing here, if anything. */
export function versionProblem(entry: ListingVersion): VersionProblem | null {
  if (entry.unavailable === "protocol") return "outdated";
  if (entry.unavailable === "node") return "runtime";
  if (entry.unavailable === "policy") return "policy";
  if (entry.unavailable === "compatibility") return "compatibility";
  if (entry.unavailable) return "unavailable";
  // On Cadencr's revocation list: the service refuses it, so it is not offered.
  if (entry.blocked) return "blocked";
  if (entry.incomplete?.length) return "incomplete";
  return null;
}

export interface InstalledState {
  version: string | null;
  /** Provider: running now. Theme: the theme on screen right now. */
  active: boolean;
  /** Theme: the installed document validated and can be applied. Provider: always. */
  usable: boolean;
  /** Provider startup selection, or a custom tab’s global enablement switch. */
  enabled?: boolean;
  /** Theme only: a saved light/dark/manual selection references it. */
  selected?: boolean;
  restartRequired: boolean;
  error?: string | null;
  /** Custom tab: on Cadencr's revocation list, with its reason. */
  blocked?: string | null;
  /** Language server: only managed installations can be removed here. */
  managed?: boolean;
  installedAt?: string;
  updatedAt?: string;
  /** Plugin: some members are missing or at another version. */
  partial?: boolean;
}

export interface MarketplaceListing {
  /** `${kind}:${id}` — unique across kinds. */
  key: string;
  kind: ListingKind;
  /**
   * Every kind installing this package contributes: its own kind for a single
   * package, a plugin's member kinds in catalog order.
   */
  contributes: PluginKind[];
  /** Plugin: the members of the release it stands for (installed, else offered). */
  members?: PluginMemberRef[];
  /** A plugin member: the plugin that ships it. Hidden from Discover, never unreachable. */
  partOf?: { id: string; name: string };
  id: string;
  name: string;
  description: string;
  publisher?: string;
  license?: string;
  repository?: string;
  website?: string;
  authors: string[];
  /** Catalog versions, newest first by version order. */
  versions: ListingVersion[];
  /** Host-computed compatible recommendation (never derived here). */
  recommended?: string;
  installed?: InstalledState;
  /** The recommended version when it is newer than the installed one. */
  update?: string;
  inCatalog: boolean;
  /** Some catalog version installs on this computer (true when none is listed). */
  availableHere: boolean;
  /** Custom tab: the native backend of the installed revision, as Cadencr runs it. */
  installedNativeCode?: TabNativeCode | null;
  /** Custom tab: a verified update staged beside the installed revision, awaiting review. */
  pendingVersion?: string | null;
  /** Custom tab: why the revocation policy blocks that staged update (it can only be discarded). */
  pendingBlocked?: string | null;
}

/** The metadata of the recommended version, else the newest one listed. */
export function pickMeta<T>(
  versions: T[] | undefined,
  version: (item: T) => string,
  recommended?: string,
) {
  return versions?.find((item) => version(item) === recommended) ?? versions?.at(-1);
}

export function baseListing(
  kind: ListingKind,
  id: string,
  versions: ListingVersion[],
  recommended: string | undefined,
  installed: InstalledState | undefined,
) {
  return {
    key: listingKey(kind, id),
    kind,
    contributes: kind === "plugin" ? [] : [kind],
    id,
    versions: sortVersions(versions),
    recommended,
    installed,
    update: newerVersion(recommended, installed?.version),
    inCatalog: versions.length > 0,
    availableHere: versions.length === 0 || versions.some((entry) => !versionProblem(entry)),
  };
}
