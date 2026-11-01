import { memo, useMemo } from "react";
import type {
  ExtensionCliSummary,
  McpListing,
  McpRegistryServer,
  SkillListing,
} from "@/api/generated";
import {
  mcpTitle,
  mcpUpdateVersion,
  skillMarketplaces,
  skillUpdates,
} from "@/lib/agent-extensions";
import { TileFrame } from "../MarketplaceTile";
import { AgentArt } from "./AgentArt";
import { AgentStateBadge } from "./AgentBits";

const MCP_CHIPS = ["mcp"] as const;
const SKILL_CHIPS = ["skill"] as const;

/** The detail route id of an MCP listing: its registry name, else its local server name. */
export function mcpRouteId(registryName: string | undefined, serverName: string): string {
  return registryName ?? `local:${serverName}`;
}

/** A registry server, with what is installed of it across CLIs when known. */
export const McpTile = memo(function McpTile({
  server,
  listing,
  clis,
}: {
  server?: McpRegistryServer | null;
  listing?: McpListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const carriedBy = useMemo(
    () => new Set(listing?.installations.map((installation) => installation.provider_id)),
    [listing],
  );
  const first = listing?.installations[0]?.server;
  const command =
    server?.options[0]?.summary ??
    first?.url ??
    [first?.command, ...(first?.args ?? [])].filter(Boolean).join(" ");
  const name = server ? mcpTitle(server) : (listing?.name ?? "");
  return (
    <TileFrame
      kind="mcp"
      chips={MCP_CHIPS}
      id={mcpRouteId(server?.name, first?.name ?? name)}
      name={name}
      meta={
        <span className="font-mono text-[10.5px]">
          {server ? `${server.name} · v${server.version}` : "Not in the MCP Registry"}
        </span>
      }
      description={server?.description || "Added to an agent CLI outside the registry."}
      badge={
        <AgentStateBadge
          installedIn={carriedBy.size}
          update={listing ? mcpUpdateVersion(listing) : undefined}
        />
      }
      art={<AgentArt command={command} clis={clis} carriedBy={carriedBy} />}
    />
  );
});

export const SkillTile = memo(function SkillTile({
  listing,
  clis,
}: {
  listing: SkillListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const carriedBy = useMemo(
    () => new Set(listing.installed.map((skill) => skill.provider_id)),
    [listing.installed],
  );
  const marketplaces = skillMarketplaces(listing);
  const installs = listing.offers.reduce((sum, offer) => sum + (offer.install_count ?? 0), 0);
  return (
    <TileFrame
      kind="skill"
      chips={SKILL_CHIPS}
      id={listing.key}
      name={listing.name}
      meta={
        <span className="font-mono text-[10.5px]">
          {[marketplaces.join(", "), installs ? `${installs.toLocaleString()} installs` : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      description={listing.description || "No description in the marketplace."}
      badge={
        <AgentStateBadge installedIn={carriedBy.size} update={skillUpdates(listing)[0]?.update} />
      }
      art={<AgentArt command={`/${listing.name}`} clis={clis} carriedBy={carriedBy} />}
    />
  );
});
