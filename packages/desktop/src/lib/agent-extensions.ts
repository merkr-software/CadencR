import type {
  ExtensionCliSummary,
  InstalledSkill,
  McpInstallation,
  McpInstallOption,
  McpListing,
  McpRegistryServer,
  SkillListing,
  SkillOffer,
} from "@/api/generated";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { matchesSidebarFilter } from "@/lib/sidebar-filter";

/** What the marketplace installs into the agent CLIs themselves, not into Cadencr. */
export const AGENT_EXTENSION_KINDS = ["skill", "mcp"] as const;
export type AgentExtensionKind = (typeof AGENT_EXTENSION_KINDS)[number];

export function isAgentExtensionKind(value: string): value is AgentExtensionKind {
  return (AGENT_EXTENSION_KINDS as readonly string[]).includes(value);
}

/** What a change in one kind can move: its inventory, never registry search results. */
export const INVENTORY_URLS = {
  mcp: "/api/agent-extensions/mcp/installed",
  skill: "/api/agent-extensions/skills",
} as const satisfies Record<AgentExtensionKind, string>;

/** Re-list every CLI's skills and MCP servers: what they read may have changed. */
export function invalidateExtensionInventories(client: QueryClient): Promise<void> {
  return invalidateByUrlPrefix(client, Object.values(INVENTORY_URLS));
}

/** The name a CLI registers a registry server under: its last path segment, made safe. */
export function defaultServerName(registryName: string): string {
  const tail = registryName.split("/").at(-1) ?? registryName;
  const safe = tail
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return safe || "mcp-server";
}

/** Why `cli` cannot carry `option` with these `values`, or null when it can. */
export function optionUnsupportedReason(
  cli: ExtensionCliSummary,
  option: McpInstallOption,
  values: Readonly<Record<string, string>> = {},
): string | null {
  if (!cli.installed) return `${cli.label} is not installed on this computer.`;
  if (!cli.support.mcp_transports.includes(option.transport)) {
    const transport =
      option.transport === "stdio" ? "local" : option.transport === "sse" ? "SSE" : "HTTP";
    return `${cli.label} cannot add ${transport} MCP servers from its command line.`;
  }
  // Headers only block a CLI when one will actually be sent.
  const sendsHeaders = option.inputs.some(
    (input) =>
      input.kind === "header" && (input.required || !!input.default || !!values[input.key]?.trim()),
  );
  if (!cli.support.mcp_headers && sendsHeaders)
    return `${cli.label} cannot attach HTTP headers from its command line.`;
  return null;
}

/** The CLIs that can carry MCP servers at all, in registry order. */
export function mcpClis(clis: ExtensionCliSummary[]): ExtensionCliSummary[] {
  return clis.filter((cli) => cli.support.mcp_transports.length > 0);
}

export function skillClis(clis: ExtensionCliSummary[]): ExtensionCliSummary[] {
  return clis.filter((cli) => cli.support.skills);
}

/** Installed listings indexed by registry name, so search results can show their state. */
export function mcpListingsByRegistryName(listings: McpListing[]): Map<string, McpListing> {
  return new Map(
    listings.flatMap((listing) => (listing.registry ? [[listing.registry.name, listing]] : [])),
  );
}

export function mcpUpdates(listing: McpListing): McpInstallation[] {
  return listing.installations.filter((installation) => installation.update);
}

/** The newest version any installation of the listing can move to. */
export function mcpUpdateVersion(listing: McpListing): string | undefined {
  return mcpUpdates(listing).find((installation) => installation.update)?.update ?? undefined;
}

export function skillUpdates(listing: SkillListing): InstalledSkill[] {
  return listing.installed.filter((skill) => skill.update);
}

/** The marketplaces a skill comes from: offered by, or installed from (`name@marketplace`). */
export function skillMarketplaces(listing: SkillListing): string[] {
  const installedFrom = listing.installed
    .filter((skill) => skill.source === "plugin")
    .map((skill) => skill.id.split("@")[1] ?? "");
  return [
    ...new Set([...listing.offers.map((offer) => offer.marketplace), ...installedFrom]),
  ].filter(Boolean);
}

/** One CLI's relation to a skill: what it has installed and what it offers. */
export interface SkillCliState {
  cli: ExtensionCliSummary;
  installed: InstalledSkill[];
  offer?: SkillOffer;
}

export function skillCliStates(
  listing: SkillListing,
  clis: ExtensionCliSummary[],
): SkillCliState[] {
  return skillClis(clis).map((cli) => ({
    cli,
    installed: listing.installed.filter((skill) => skill.provider_id === cli.provider_id),
    // A pack listed by two of the CLI's marketplaces installs from the most used one.
    offer: listing.offers
      .filter((offer) => offer.provider_id === cli.provider_id)
      .sort((a, b) => (b.install_count ?? 0) - (a.install_count ?? 0))[0],
  }));
}

/** Whether Cadencr can change `skill` with the CLI: a marketplace pack in the user's own scope. */
export function skillIsChangeable(skill: Pick<InstalledSkill, "source" | "scope">): boolean {
  return skill.source === "plugin" && (!skill.scope || skill.scope === "user");
}

/** A CLI's display name, its provider id when the CLI list does not have it. */
export function cliLabel(clis: readonly ExtensionCliSummary[], providerId: string): string {
  return clis.find((cli) => cli.provider_id === providerId)?.label ?? providerId;
}

/** The display title of a registry server. */
export function mcpTitle(server: Pick<McpRegistryServer, "name" | "title">): string {
  return server.title || defaultServerName(server.name);
}

/** Every term appears in the listing's name, registry name, description or server names. */
export function matchesMcpListing(listing: McpListing, terms: readonly string[]): boolean {
  return matchesSidebarFilter(terms, [
    listing.name,
    listing.registry?.name,
    listing.registry?.description,
    ...listing.installations.map((installation) => installation.server.name),
  ]);
}

export function matchesSkillListing(listing: SkillListing, terms: readonly string[]): boolean {
  return matchesSidebarFilter(terms, [listing.name, listing.description]);
}
