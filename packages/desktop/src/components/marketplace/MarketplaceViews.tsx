import type { ExtensionCliSummary } from "@/api/generated";
import { isAgentExtensionKind, mcpClis, skillClis } from "@/lib/agent-extensions";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { AgentShelves, McpBrowse, SkillBrowse } from "./agent/AgentDiscover";
import { AgentLibrary } from "./agent/AgentLibrary";
import { KindFilterBar, MarketplaceDiscover, type KindFilter } from "./MarketplaceDiscover";
import { MarketplaceLibrary } from "./MarketplaceLibrary";
import { MarketplaceSpotlight } from "./MarketplaceSpotlight";
import { MarketplaceNotInBuild, MarketplaceUnavailable } from "./MarketplaceStates";

/** The agent kinds a filter pill is offered for: some CLI here can install them. */
function agentKinds(clis: ExtensionCliSummary[]) {
  const installed = clis.filter((cli) => cli.installed);
  return [
    ...(skillClis(installed).length ? [{ kind: "skill" as const }] : []),
    ...(mcpClis(installed).length ? [{ kind: "mcp" as const }] : []),
  ];
}

export function DiscoverView({
  kind,
  query,
  searched,
  spotlight,
  clis,
  anyCatalog,
  catalogMissing,
  refreshing,
  onRefresh,
  onKindChange,
  scrollParent,
}: {
  kind: KindFilter;
  query: string;
  searched: MarketplaceListing[];
  spotlight: MarketplaceListing[];
  clis: ExtensionCliSummary[];
  anyCatalog: boolean;
  catalogMissing: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onKindChange: (kind: KindFilter) => void;
  scrollParent: HTMLElement | null;
}): React.JSX.Element {
  const agent = isAgentExtensionKind(kind);
  const searching = !!query.trim();
  const filterBar = (
    <KindFilterBar
      listings={searched}
      kind={kind}
      onKindChange={onKindChange}
      agentKinds={agentKinds(clis)}
    />
  );
  if (agent)
    return (
      <>
        {filterBar}
        {kind === "skill" ? (
          <SkillBrowse query={query} clis={clis} scrollParent={scrollParent} />
        ) : (
          <McpBrowse query={query} clis={clis} scrollParent={scrollParent} />
        )}
      </>
    );
  const showPlugins = anyCatalog || searched.length > 0;
  return (
    <>
      {!anyCatalog &&
        (catalogMissing ? (
          <MarketplaceNotInBuild />
        ) : (
          <MarketplaceUnavailable refreshing={refreshing} onRefresh={onRefresh} />
        ))}
      {!searching && <MarketplaceSpotlight listings={spotlight} />}
      {filterBar}
      {showPlugins && !(kind === "all" && searching && searched.length === 0) && (
        <MarketplaceDiscover
          listings={searched}
          kind={kind}
          searching={searching}
          onKindChange={onKindChange}
          scrollParent={scrollParent}
        />
      )}
      {kind === "all" && agentKinds(clis).length > 0 && (
        <div className="space-y-8 pt-2">
          <AgentShelves clis={clis} query={query} onKindChange={onKindChange} />
        </div>
      )}
    </>
  );
}

export function LibraryView({
  view,
  kind,
  query,
  listings,
  scrollParent,
  publishedAt,
  refreshing,
  onRefresh,
  onDiscover,
  onKindChange,
  clis,
}: {
  view: "installed" | "updates";
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  clis: ExtensionCliSummary[];
  query: string;
  listings: MarketplaceListing[];
  scrollParent: HTMLElement | null;
  publishedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onDiscover: () => void;
}): React.JSX.Element {
  if (isAgentExtensionKind(kind))
    return (
      <>
        <KindFilterBar
          listings={[]}
          kind={kind}
          onKindChange={onKindChange}
          agentKinds={agentKinds(clis)}
        />
        <AgentLibrary view={view} kinds={[kind]} query={query} scrollParent={scrollParent} />
      </>
    );
  // Cadencr's own plugins have one list whatever kind Discover was filtered to.
  return (
    <>
      <MarketplaceLibrary
        view={view}
        listings={listings}
        scrollParent={scrollParent}
        publishedAt={publishedAt}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onDiscover={onDiscover}
      />
      {agentKinds(clis).length > 0 && (
        <section aria-labelledby="mp-agent-library" className="space-y-3 pt-4">
          <div>
            <h2 id="mp-agent-library" className="text-[15px] font-semibold">
              In your agent CLIs
            </h2>
            <p className="text-xs text-muted-foreground">
              Skills and MCP servers each CLI reports, wherever they were installed from.
            </p>
          </div>
          <AgentLibrary
            view={view}
            kinds={["skill", "mcp"]}
            query={query}
            scrollParent={scrollParent}
          />
        </section>
      )}
    </>
  );
}
